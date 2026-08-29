import PromisesTracker from '../../../components/promises-tracker';

export const dynamic = 'force-dynamic';

export default function PromisesPage() {
  return (
    <div className="mx-auto max-w-6xl">
        <h1 className="text-xl sm:text-2xl font-bold text-slate-100">
          Promise-to-Pay Tracker
        </h1>
        <p className="mt-1 text-sm text-slate-400">
          Monitor customer payment promises and manage escalation workflows.
        </p>
        <div className="mt-6">
          <PromisesTracker />
        </div>
    </div>
  );
}
