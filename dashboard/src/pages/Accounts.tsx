import { useMe } from '@/api/client';
import { AccountLinks } from '../components/AccountLinks';
import { Layout } from '../components/Layout';

export function Accounts() {
    const { data: me, isPending } = useMe();
    return (
        <Layout title="Account linking" requiredAuth="either">
            {isPending ? (
                <p>Loading…</p>
            ) : me?.isOwner ? (
                <AccountLinks />
            ) : (
                <p role="alert">
                    Only the instance owner can manage account links.
                </p>
            )}
        </Layout>
    );
}
