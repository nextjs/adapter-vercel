import { headers } from 'next/headers';
export default async function Page() {
  return <p>Host: {(await headers()).get('host')}</p>;
}
