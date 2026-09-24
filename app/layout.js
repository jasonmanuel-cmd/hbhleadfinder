import './globals.css';
import Nav from '@/components/Nav';

export const metadata = {
  title: 'Harbison Buys Homes — Lead Desk',
  description: 'Distressed-property lead intelligence',
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>
        <Nav />
        <main>{children}</main>
      </body>
    </html>
  );
}
