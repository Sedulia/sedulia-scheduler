export const dynamic = 'force-dynamic';
import { Login } from '@gitroom/frontend/components/auth/login';
import { Metadata } from 'next';
export const metadata: Metadata = {
  title: `Sedulia Social Login`,
  description: '',
};
export default async function Auth() {
  return <Login />;
}
