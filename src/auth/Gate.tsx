import { useState, type FormEvent } from 'react';
import { FileText } from '@phosphor-icons/react';
import { APP_NAME } from '../../shared/limits.ts';
import { useAuth } from './AuthProvider.tsx';

/** Full-screen gate. Used as the first screen and as an overlay when a session ends mid-work. */
export function Gate({ overlay = false }: { overlay?: boolean }) {
  const a = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mode, setMode] = useState<'signin' | 'forgot'>('signin');

  const settingPassword = a.phase === 'invite' || a.phase === 'recovery';

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (a.busy) return;
    if (settingPassword) {
      if (password.length < 8) return;
      return a.phase === 'invite' ? a.finishInvite(password) : a.finishRecovery(password);
    }
    if (mode === 'forgot') return a.forgot(email);
    return a.signIn(email, password);
  }

  const title = settingPassword ? (a.phase === 'invite' ? 'Welcome' : 'New password') : APP_NAME;
  const sub = settingPassword
    ? a.phase === 'invite'
      ? 'Choose a password to finish setting up your account.'
      : 'Choose a new password for your account.'
    : mode === 'forgot'
      ? "Enter your email and we'll send a reset link."
      : a.sessionEnded
        ? 'Your session ended. Sign in to keep working. Your unsaved changes are safe.'
        : 'Sign in to fill your templates.';

  return (
    <div className="gate" style={overlay ? { position: 'fixed', inset: 0, zIndex: 100, background: 'color-mix(in srgb, var(--color-bg) 88%, transparent)', backdropFilter: 'blur(4px)' } : undefined}>
      <form className="gate-card" onSubmit={submit} noValidate>
        <div className="gate-mark"><FileText size={20} /></div>
        <div>
          <h4 style={{ marginBottom: 2 }}>{title}</h4>
          <div className="muted" style={{ fontSize: 13 }}>{sub}</div>
        </div>
        {!settingPassword && (
          <div className="field">
            <label htmlFor="email">Email</label>
            <input id="email" className="input" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
          </div>
        )}
        {(settingPassword || mode === 'signin') && (
          <div className="field">
            <label htmlFor="password">{settingPassword ? 'New password (at least 8 characters)' : 'Password'}</label>
            <input id="password" className="input" type="password" autoComplete={settingPassword ? 'new-password' : 'current-password'} value={password} onChange={(e) => setPassword(e.target.value)} autoFocus={settingPassword} />
          </div>
        )}
        {a.error && <div className="err-text" role="alert">{a.error}</div>}
        {a.notice && <div className="muted" style={{ fontSize: 13 }} role="status">{a.notice}</div>}
        <button className="btn btn-primary btn-block" type="submit" disabled={a.busy || (settingPassword && password.length < 8)}>
          {a.busy ? 'One moment…' : settingPassword ? 'Save password' : mode === 'forgot' ? 'Send reset link' : 'Sign in'}
        </button>
        {!settingPassword && (
          <div className="row-between" style={{ fontSize: 13 }}>
            <button type="button" className="btn btn-ghost" onClick={() => { a.clearMessages(); setMode(mode === 'signin' ? 'forgot' : 'signin'); }}>
              {mode === 'signin' ? 'Forgot password?' : 'Back to sign in'}
            </button>
          </div>
        )}
        {!settingPassword && <div className="muted" style={{ fontSize: 12 }}>Need access? Ask an admin to invite you.</div>}
      </form>
    </div>
  );
}
