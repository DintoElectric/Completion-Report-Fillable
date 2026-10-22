import { lazy, Suspense } from 'react';
import { AuthProvider, useAuth } from '../auth/AuthProvider.tsx';
import { Gate } from '../auth/Gate.tsx';
import { ToastProvider } from './ui.tsx';
import { useRoute } from './router.ts';
import Jobs from '../screens/Jobs.tsx';
import Job from '../screens/Job.tsx';
import Templates from '../screens/Templates.tsx';

// The Fill screen carries the spreadsheet and PDF readers, so it loads only when someone opens it.
const Fill = lazy(() => import('../screens/Fill.tsx'));

function Routes() {
  const route = useRoute();
  switch (route.name) {
    case 'jobs': return <Jobs />;
    case 'job': return <Job key={route.id} jobId={route.id} />;
    case 'fill': return <Suspense fallback={<div className="gate"><span className="spinner" /></div>}><Fill key={route.id} jobId={route.id} /></Suspense>;
    case 'templates': return <Templates />;
  }
}

function Shell() {
  const a = useAuth();
  if (a.phase === 'loading') return <div className="gate"><span className="spinner" /></div>;
  if (a.phase === 'invite' || a.phase === 'recovery') return <Gate />;
  if (a.phase === 'signed-out' && !(a.sessionEnded && a.me)) return <Gate />;
  return (
    <>
      <div className="app"><Routes /></div>
      {/* Session ended mid-work: the sign-in sits over the app, which stays mounted so nothing typed is lost. */}
      {a.phase === 'signed-out' && a.sessionEnded && <Gate overlay />}
    </>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <ToastProvider>
        <Shell />
      </ToastProvider>
    </AuthProvider>
  );
}
