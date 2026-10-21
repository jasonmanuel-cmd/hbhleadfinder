import { login } from './actions';

export default async function LoginPage({ searchParams }) {
  const sp = await searchParams;
  // The local development server shows the password on the page so nobody has to
  // guess at it. Never shown in production.
  const showHint = process.env.NODE_ENV !== 'production' && process.env.SHOW_LOGIN_HINT === '1';
  return (
    <div className="login card">
      <h1>Lead Desk</h1>
      <p className="sub">Private — authorized team only.</p>
      {sp?.error && <div className="alert err">Wrong password.</div>}
      <form action={login}>
        <label htmlFor="password">Password</label>
        <input id="password" name="password" type="password" autoComplete="current-password" required autoFocus />
        <div style={{ marginTop: 14 }}><button className="btn primary" type="submit">Sign in</button></div>
      </form>
      {showHint && (
        <p className="sub" style={{ marginTop: 16 }}>
          Local development password: <code>{process.env.DASHBOARD_PASSWORD}</code>
        </p>
      )}
    </div>
  );
}
