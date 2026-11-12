export async function getStaticProps() {
  return { props: { message: 'ISR parity' }, revalidate: 60 };
}
export default function Page({ message }) {
  return <p>{message}</p>;
}
