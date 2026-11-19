import { Suspense } from 'react';

export default function Layout({ children }) {
  return (
    <html lang="en">
      <body>
        <h1>Bot fixture</h1>
        <Suspense fallback={<p>Loading</p>}>{children}</Suspense>
      </body>
    </html>
  );
}
