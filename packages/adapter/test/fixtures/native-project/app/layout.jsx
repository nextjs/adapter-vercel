import { Suspense } from 'react';
export default function Layout({ children }) {
  return (
    <html lang="en">
      <body>
        <Suspense fallback={<p>Loading</p>}>{children}</Suspense>
      </body>
    </html>
  );
}
