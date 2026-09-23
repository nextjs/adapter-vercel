export function generateStaticParams() {
  const count = Number(process.env.BENCHMARK_PAGES ?? 6646);
  if (!Number.isSafeInteger(count) || count < 1) {
    throw new Error('BENCHMARK_PAGES must be a positive integer');
  }
  return Array.from({ length: count }, (_, index) => ({
    slug: `page-${String(index).padStart(5, '0')}`,
  }));
}

async function Content({ params }) {
  const { slug } = await params;
  return <p>{slug}</p>;
}

export default function Page({ params }) {
  return (
    <main>
      <h1>Prerender benchmark</h1>
      <Content params={params} />
    </main>
  );
}
