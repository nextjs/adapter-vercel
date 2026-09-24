export function generateStaticParams() {
  const count = Number(process.env.BENCHMARK_VARIANTS ?? 1);
  if (!Number.isSafeInteger(count) || count < 1) {
    throw new Error('BENCHMARK_VARIANTS must be a positive integer');
  }
  return Array.from({ length: count }, (_, index) => ({
    variant: `variant-${String(index).padStart(3, '0')}`,
  }));
}

export default function VariantLayout({ children }) {
  return children;
}
