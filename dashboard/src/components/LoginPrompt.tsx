import { PlatformLoginButton } from './PlatformLoginButton';
import {
    Card,
    CardDescription,
    CardHeader,
    CardPanel,
    CardTitle,
} from './ui/card';

function LoginPrompt() {
    return (
        <Card className="mx-auto mt-16 max-w-md">
            <CardHeader>
                <CardTitle>Connect your accounts</CardTitle>
                <CardDescription>
                    Log in with Discord and Fluxer to manage your bridged
                    servers and channels.
                </CardDescription>
            </CardHeader>
            <CardPanel className="flex flex-col gap-3">
                <PlatformLoginButton
                    platform="discord"
                    href="/api/auth/discord/login"
                />
                <PlatformLoginButton
                    platform="fluxer"
                    href="/api/auth/fluxer/login"
                />
            </CardPanel>
        </Card>
    );
}

export default LoginPrompt;
