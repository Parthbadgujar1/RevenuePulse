import AppNav from '../../components/app-nav';
import PromisesTracker from '../../components/promises-tracker';

export const dynamic = 'force-dynamic';

export default function PromisesPage() {
  return (
    <div className="min-h-screen bg-slate-950">
      <AppNav />
      <div className="mx-auto max-w-6xl p-4 sm:p-6 lg:p-8">
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
    </div>
  );
}
