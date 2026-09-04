// AI Recovery Decision Card — makes the agent's reasoning visible on the case
// page: diagnosis → ML probability → AI recommendation → policy verdict →
// final decision. Rendered server-side from persisted rows.
import { humanizeAction, categoryLabel } from '../lib/ui';

interface DecisionCardProps {
  diag: Record<string, unknown>;
  prediction: {
    probability: number;
    confidence: number;
    modelVersion: string;
  } | null;
  agentEntry: {
    reason: string;
    diagnosis?: { category: string; confidence: number; evidence?: string[] };
    proposedAction?: string;
    finalDecision?: string;
    llm?: { provider: string; model: string; succeeded: boolean };
    policyAllowed?: boolean;
    violations?: string[];
  } | null;
  actionSnapshot: {
    actionType?: string | null;
    probability?: number;
    rationale?: string;
    violations?: string[];
    stoppingRuleTriggered?: boolean;
    blockedAlternatives?: Array<{ action: string; reason: string }>;
  } | null;
}

export default function AiDecisionCard({
  diag,
  prediction,
  agentEntry,
  actionSnapshot,
}: DecisionCardProps) {
  const primaryCategory = (diag.primaryCategory as string) ?? agentEntry?.diagnosis?.category ?? 'unknown';
  const diagnosisConfidence =
    agentEntry?.diagnosis?.confidence ?? (diag.primaryCategoryConfidence as number | undefined) ?? 0;

  const finalAction =
    agentEntry?.finalDecision ?? actionSnapshot?.actionType ?? 'Pending';
  const isNoAction = finalAction.toLowerCase().includes('do_nothing') || finalAction === 'do_nothing';
  const llmSucceeded = agentEntry?.llm?.succeeded ?? false;
  const llmProvider = agentEntry?.llm?.provider;
  const llmModel = agentEntry?.llm?.model;

  const violations = agentEntry?.violations ?? actionSnapshot?.violations ?? [];
  const stopped = actionSnapshot?.stoppingRuleTriggered ?? false;
  const policyAllowed = agentEntry?.policyAllowed ?? (violations.length === 0 && !stopped);

  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900 p-4 shadow-sm">
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
          AI Recovery Decision
        </p>
        {llmSucceeded && llmProvider ? (
          <span className="rounded-full border border-purple-500/30 bg-purple-500/10 px-2 py-0.5 text-[10px] font-semibold text-purple-300">
            {llmProvider === 'gemini' ? 'Gemini' : llmProvider === 'groq' ? 'Groq' : llmProvider} · {llmModel}
          </span>
        ) : (
          <span className="rounded-full border border-slate-700 bg-slate-800 px-2 py-0.5 text-[10px] font-semibold text-slate-400">
            Deterministic reasoning
          </span>
        )}
      </div>

      <dl className="mt-3 space-y-2.5 text-sm">
        <div className="flex items-start justify-between gap-3">
          <dt className="text-slate-400">Diagnosis</dt>
          <dd className="text-right font-medium text-slate-100">{categoryLabel(primaryCategory)}</dd>
        </div>
        <div className="flex items-start justify-between gap-3">
          <dt className="text-slate-400">AI confidence</dt>
          <dd className="text-right font-medium text-slate-100">
            {diagnosisConfidence > 0 ? `${(diagnosisConfidence * 100).toFixed(0)}%` : '—'}
          </dd>
        </div>
        <div className="flex items-start justify-between gap-3">
          <dt className="text-slate-400">ML recovery chance</dt>
          <dd className="text-right font-medium text-slate-100">
            {prediction ? `${(prediction.probability * 100).toFixed(0)}%` : '—'}
          </dd>
        </div>
        <div className="flex items-start justify-between gap-3">
          <dt className="text-slate-400">AI recommendation</dt>
          <dd className="text-right font-medium text-slate-100">
            {agentEntry?.proposedAction ? humanizeAction(agentEntry.proposedAction) : '—'}
          </dd>
        </div>
      </dl>

      {/* Why — the rationale */}
      {(agentEntry?.reason || actionSnapshot?.rationale) && (
        <p className="mt-3 border-t border-slate-800 pt-3 text-xs leading-relaxed text-slate-300">
          {agentEntry?.reason || actionSnapshot?.rationale}
        </p>
      )}

      {/* Policy verdict */}
      <div className="mt-3 rounded-md border border-slate-800 bg-slate-950 p-3">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium uppercase tracking-wide text-slate-500">Policy check</span>
          {stopped ? (
            <span className="rounded-full bg-red-500/15 px-2 py-0.5 text-[11px] font-semibold text-red-300">
              STOPPED by rule
            </span>
          ) : !isNoAction && !policyAllowed ? (
            <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] font-semibold text-amber-300">
              BLOCKED
            </span>
          ) : (
            <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-[11px] font-semibold text-emerald-300">
              ✓ within guardrails
            </span>
          )}
        </div>
        {violations.length > 0 && (
          <ul className="mt-2 space-y-1">
            {violations.map((v, i) => (
              <li key={i} className="text-[11px] text-amber-400">
                • {v}
              </li>
            ))}
          </ul>
        )}
        {actionSnapshot?.blockedAlternatives && actionSnapshot.blockedAlternatives.length > 0 && (
          <p className="mt-2 text-[11px] text-slate-500">
            Considered &amp; rejected:
            {actionSnapshot.blockedAlternatives
              .slice(0, 3)
              .map((b) => ` ${humanizeAction(b.action)} (${b.reason.toLowerCase()})`)
              .join(' · ')}
          </p>
        )}
      </div>

      {/* Final decision */}
      <div
        className={`mt-3 flex items-center justify-between rounded-md border p-3 ${
          isNoAction
            ? 'border-slate-700 bg-slate-900'
            : 'border-emerald-500/40 bg-emerald-500/10'
        }`}
      >
        <span className="text-xs font-medium uppercase tracking-wide text-slate-500">
          Final decision {stopped ? '(stopped)' : ''}
        </span>
        <span
          className={`text-sm font-bold ${
            isNoAction || stopped ? 'text-slate-300' : 'text-emerald-300'
          }`}
        >
          {isNoAction ? '🚫 DO NOTHING' : `✓ ${humanizeAction(finalAction)}`}
        </span>
      </div>

      <p className="mt-2 text-[10px] leading-relaxed text-slate-600">
        AI recommends. Policy authorizes. Razorpay executes. Evidence verifies.
      </p>
    </div>
  );
}