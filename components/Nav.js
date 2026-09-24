import { cookies } from 'next/headers';
import { COOKIE } from '@/lib/auth';
import { logout } from '@/app/login/actions';

export default async function Nav() {
  const signedIn = Boolean((await cookies()).get(COOKIE));
  return (
    <nav className="nav">
      <div className="nav-inner">
        <a href="/" className="brand"><span className="brand-mark">H</span>Harbison Buys Homes</a>
        {signedIn && (
          <>
            <a className="link" href="/">Today</a>
            <a className="link" href="/leads">Leads</a>
            <a className="link" href="/add">Add / Import</a>
            <a className="link" href="/review">Review</a>
            <a className="link" href="/sources">Sources</a>
            <span className="spacer" />
            <form action={logout} className="inline"><button className="btn sm">Sign out</button></form>
          </>
        )}
      </div>
    </nav>
  );
}
