import { fileURLToPath, pathToFileURL } from 'node:url';

function reviewRoundsModulePath() {
  return fileURLToPath(new URL('./ai-review-rounds-lib.mjs', import.meta.url));
}

function reviewLensesModulePath() {
  const testOverride = process.env.AI_DEV_TOOL_REVIEW_LENSES_PATH;
  if (
    testOverride &&
    process.env.NODE_ENV === 'test' &&
    process.env.AI_DEV_TOOL_ALLOW_REVIEW_LENSES_PATH === '1'
  ) {
    return testOverride;
  }
  return fileURLToPath(new URL('./ai-review-rounds-lib.mjs', import.meta.url));
}

export async function focusedReviewPlan(root, task, { freezeSize = false } = {}) {
  let roundsModule;
  try {
    roundsModule = await import(pathToFileURL(reviewRoundsModulePath()).href);
  } catch {
    return { status: 'unavailable', lens: null, round: null, maxRounds: null };
  }
  if (typeof roundsModule.loadReviewRounds !== 'function') {
    return { status: 'unavailable', lens: null, round: null, maxRounds: null };
  }
  let loaded;
  try {
    // dry-runや状態表示では未確定のまま読む。--yesのround 1送信時だけ、
    // その時点の差分を測定して以降の往復へ固定する。
    loaded = roundsModule.loadReviewRounds(root, task, { persist: false });
    if (
      freezeSize
      && loaded.state?.codeReview?.rounds?.length === 0
      && typeof roundsModule.freezeReviewSizeAtFirstSend === 'function'
    ) {
      loaded = {
        ...loaded,
        state: roundsModule.freezeReviewSizeAtFirstSend(root, task).state,
      };
    }
  } catch (error) {
    return {
      status: 'error',
      error: String(error?.message || error || 'レビュー開始時の変更量を確認できません'),
      lens: null,
      round: null,
      maxRounds: null,
    };
  }
  const measurementWarning = String(
    loaded.state?.codeReview?.sizeEvidence?.measurementWarning || '',
  ).trim();
  try {
    const completedRounds = loaded.state?.codeReview?.rounds?.length || 0;
    const maxRounds = typeof roundsModule.codeReviewMaxRounds === 'function'
      ? roundsModule.codeReviewMaxRounds(loaded.state)
      : null;
    const focusedRecheckPending = loaded.state?.codeReview?.focusedRecheck?.status === 'pending';
    const closed = typeof roundsModule.codeReviewClosed === 'function'
      ? roundsModule.codeReviewClosed(loaded.state)
      : Number.isInteger(maxRounds) && completedRounds >= maxRounds;
    if (closed || (Number.isInteger(maxRounds) && completedRounds >= maxRounds && !focusedRecheckPending)) {
      return {
        status: 'closed',
        lens: null,
        round: completedRounds + 1,
        maxRounds,
        measurementWarning,
        handoff: typeof roundsModule.reviewHandoffSummary === 'function'
          ? roundsModule.reviewHandoffSummary(loaded.state)
          : '',
        notificationStatus: loaded.state.codeReview.parentEscalation?.notification?.status || null,
      };
    }

    const lensesModule = await import(pathToFileURL(reviewLensesModulePath()).href);
    const lenses = reviewLensesModulePath() === reviewRoundsModulePath() && typeof roundsModule.reviewLensesForTask === 'function'
      ? roundsModule.reviewLensesForTask(task, loaded.state, { root })
      : lensesModule.CODE_REVIEW_LENSES;
    if (!Array.isArray(lenses)) {
      return { status: 'unavailable', lens: null, round: completedRounds + 1, maxRounds };
    }
    // 2026-09-28: 限定再確認は「指摘が出た元の観点」だけを再確認する。pending で最後の観点へ
    // フォールバックすると、別観点の再確認結果が元の指摘を消し得るため行わない。pending の観点keyが
    // 未記録・未知なら勝手に選ばず、下の focus 検証で status:'unavailable' へ落とす(送信側が拒否する)。
    const pendingRecheckLensKey = focusedRecheckPending
      ? String(loaded.state?.codeReview?.focusedRecheck?.lens || '').trim()
      : '';
    const recheckLensCandidates = roundsModule.COMPREHENSIVE_CODE_REVIEW_LENS
      ? [...lenses, roundsModule.COMPREHENSIVE_CODE_REVIEW_LENS]
      : lenses;
    const lens = focusedRecheckPending
      ? (pendingRecheckLensKey
        ? recheckLensCandidates.find((candidate) => candidate.key === pendingRecheckLensKey) || null
        : null)
      : typeof roundsModule.nextCodeReviewLens === 'function'
        ? roundsModule.nextCodeReviewLens(loaded.state, lenses)
        : null;
    if (typeof lens?.focus !== 'string' || !lens.focus.trim()) {
      return { status: 'unavailable', lens: null, round: completedRounds + 1, maxRounds };
    }
    return {
      status: 'ready',
      round: focusedRecheckPending ? maxRounds : completedRounds + 1,
      recheck: focusedRecheckPending ? 1 : null,
      maxRounds,
      reviewChainVersion: typeof roundsModule.reviewChainVersionForTask === 'function'
        ? roundsModule.reviewChainVersionForTask(task, loaded.state, { root })
        : loaded.state?.codeReview?.reviewChainVersion || null,
      measurementWarning,
      handoff: typeof roundsModule.reviewHandoffSummary === 'function'
        ? roundsModule.reviewHandoffSummary(loaded.state)
        : '',
      commonRules: Array.isArray(roundsModule.CODE_REVIEW_COMMON_RULES)
        ? roundsModule.CODE_REVIEW_COMMON_RULES
        : [],
      lens: {
        ...lens,
        runtime: typeof roundsModule.codeReviewReviewerRuntime === 'function'
          ? roundsModule.codeReviewReviewerRuntime(lens)
          : null,
        sourceRound: Number.isInteger(lens.round) ? lens.round : null,
        round: focusedRecheckPending ? maxRounds : completedRounds + 1,
        recheck: focusedRecheckPending ? 1 : null,
      },
    };
  } catch (error) {
    // 観点moduleを差し替えた環境で差し替え先を読めない場合は、方式を断定せず利用不可として返す。
    if (error?.code === 'ERR_MODULE_NOT_FOUND' && reviewLensesModulePath() !== reviewRoundsModulePath()) return { status: 'unavailable', lens: null, round: null, maxRounds: null };
    return {
      status: 'error',
      error: String(error?.message || error || '保存済みレビュー方式を利用できません'),
      lens: null,
      round: null,
      maxRounds: null,
    };
  }
}

export async function focusedReviewLens(root, task) {
  return (await focusedReviewPlan(root, task)).lens;
}

export function reviewPointsBody(reviewPoints, lens) {
  if (!lens) return reviewPoints.map((point) => `- ${point}`).join('\n');
  return `- ${lens.focus.trim()}\n\nこの往復は上記の観点を担当してください。観点外でも実在する機能の不具合を見つけた場合は報告してください。`;
}
