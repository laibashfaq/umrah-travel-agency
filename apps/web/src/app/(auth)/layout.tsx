import type { Metadata } from 'next';

export const metadata: Metadata = { robots: { index: false, follow: false } };
// Reads cookies and the session, so these pages are never cached or prerendered.
export const dynamic = 'force-dynamic';

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <main id="main-content" tabIndex={-1} className="grid min-h-dvh place-items-center bg-muted/40 bg-pattern-dark px-4 py-10 focus:outline-none">
      {children}
    </main>
  );
}
