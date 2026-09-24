'use client';
export default function PrintButton() {
  return <button className="btn primary sm" onClick={() => window.print()}>Print</button>;
}
