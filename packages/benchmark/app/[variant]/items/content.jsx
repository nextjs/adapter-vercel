import { connection } from 'next/server';
import { Suspense } from 'react';

async function Content({ params, title }) {
  const { variant } = await params;
  return (
    <p>
      {title}: {variant}
    </p>
  );
}

// Request-time content, so each prerendered page has a postponed state.
async function Dynamic() {
  await connection();
  return <p>{new Date().toISOString()}</p>;
}

export default function ItemPage({ params, title }) {
  return (
    <main>
      <h1>{title}</h1>
      <Content params={params} title={title} />
      <Suspense fallback={<p>Loading...</p>}>
        <Dynamic />
      </Suspense>
    </main>
  );
}
