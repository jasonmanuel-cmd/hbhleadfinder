import { login } from './actions';

export default async function LoginPage({ searchParams }) {
  const sp = await searchParams;
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
    </div>
  );
}
