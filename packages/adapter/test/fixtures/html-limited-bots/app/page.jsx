import { connection } from 'next/server';

export async function generateMetadata() {
  if (process.env.TEST_CACHE_COMPONENTS === 'true') {
    await connection();
  }
  return { title: 'Dynamic fixture metadata' };
}

export default async function Page() {
  if (process.env.TEST_CACHE_COMPONENTS === 'true') {
    await connection();
  }
  return <p>App Page prerender</p>;
}
