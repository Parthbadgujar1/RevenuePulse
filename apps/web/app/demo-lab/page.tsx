// Demo Lab - generate synthetic failures and watch the AI recovery pipeline run
import AppNav from '../../components/app-nav';
import RunDemoForm from '../../components/run-demo-form';
import DemoGeneratePanel from '../../components/demo-generate-panel';

export const metadata = { title: 'Demo Lab — RevenuePulse' };

export default function DemoLabPage() {
  return (
    <div className="min-h-screen bg-slate-950">
      <AppNav />
      <div className="mx-auto max-w-4xl p-4 sm:p-6 lg:p-8">
        <h1 className="text-xl sm:text-2xl font-bold text-slate-100">Demo Lab</h1>
        <p className="mb-6 mt-1 text-sm text-slate-400">
          The fastest way to see the full product: generate a cohort of failed payments and watch
          the agent diagnose, score, decide under policy, act within bounds and verify every rupee
          recovered.
        </p>
        <div className="space-y-6">
          <RunDemoForm />
          <DemoGeneratePanel />
        </div>
      </div>
    </div>
  );
}
