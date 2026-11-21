export interface ApplyResult {
  code: 'OK' | 'NO_CHANGE' | 'APPLY_FAILED' | 'RECOVERY_INCOMPLETE';
  message?: string;
}

export interface ActiveState {
  planId: string | null;
  previousVersion?: string | null;
  pendingPlanId?: string;
  phase?: 'preflight' | 'switch' | 'open' | 'finalize' | 'recovery';
  finalizeFailed?: boolean;
  openFailed?: boolean;
  closedRoutes?: string[];
  results?: Record<string, ApplyResult>;
}

export function statusSnapshot(state: ActiveState) {
  return {
    currentVersion: state.planId, previousVersion: state.previousVersion ?? null,
    phase: state.phase ?? (state.pendingPlanId ? 'switch' : 'ready'),
    pendingPlanId: state.pendingPlanId ?? null, closedRoutes: state.closedRoutes ?? [],
    recoveryIncomplete: state.phase === 'recovery' || Boolean(state.finalizeFailed || state.openFailed),
  };
}
