import type { ReactNode } from "react";
import {
  Alert,
  Button,
  Group,
  Loader,
  Paper,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import {
  IconBrandGithub,
  IconBrandGoogle,
  IconCheck,
  IconExternalLink,
  IconMail,
  IconShieldCheck,
} from "@tabler/icons-react";

type Props = {
  stage: "sign-in" | "waiting" | "error";
  onStart: () => void;
  onReopen: () => void;
  onCancel: () => void;
  onManageBrowserAccount?: () => void;
  error?: string;
  notice?: string;
  restartNotice?: string;
  previewControls?: ReactNode;
};

export default function AccountSignIn({
  stage,
  onStart,
  onReopen,
  onCancel,
  onManageBrowserAccount,
  error,
  notice,
  restartNotice,
  previewControls,
}: Props) {
  return (
    <Paper className="account-card" withBorder radius="lg">
      <Stack gap={24}>
        <div>
          <Title order={1} tabIndex={-1}>
            Sign in to Palisade
          </Title>
          <Text className="account-description">
            Sign in to create your local profile and get back to building.
          </Text>
        </div>
        {restartNotice && (
          <Alert
            color="success"
            icon={<IconCheck size={18} />}
            title="Ready for another account"
          >
            {restartNotice}
          </Alert>
        )}
        {stage === "waiting" ? (
          <>
            <div className="account-waiting" role="status">
              <Loader size="sm" />
              <div>
                <Text fw={600}>Finish signing in in your browser</Text>
                <Text size="sm" c="dimmed">
                  Palisade will pick up right where you left off.
                </Text>
              </div>
            </div>
            <Button
              variant="default"
              leftSection={<IconExternalLink size={16} />}
              onClick={onReopen}
            >
              Open browser again
            </Button>
            <Button variant="subtle" onClick={onCancel}>
              Cancel sign-in
            </Button>
            {previewControls}
          </>
        ) : (
          <>
            {stage === "error" && (
              <Alert color="danger" title="Sign-in didn’t finish">
                {error || "Your workspace is safe. Try again to continue."}
              </Alert>
            )}
            <Stack gap={12}>
              <Button
                size="md"
                rightSection={<IconExternalLink size={17} />}
                onClick={onStart}
              >
                {stage === "error"
                  ? "Try sign-in again"
                  : "Continue in browser"}
              </Button>
              <Group justify="center" gap="lg" className="account-methods">
                <span>
                  <IconBrandGoogle size={16} />
                  Google
                </span>
                <span>
                  <IconBrandGithub size={16} />
                  GitHub
                </span>
                <span>
                  <IconMail size={16} />
                  Email code
                </span>
              </Group>
              <Text size="sm" c="dimmed" ta="center">
                Return here after you finish signing in.
              </Text>
              {onManageBrowserAccount && (
                <>
                  <Text size="sm" c="dimmed" ta="center">
                    Your browser may remember your last account. To use another,
                    sign out on the browser account page first, then continue
                    here.
                  </Text>
                  <Button
                    variant="subtle"
                    onClick={onManageBrowserAccount}
                    rightSection={<IconExternalLink size={16} />}
                  >
                    Open browser account
                  </Button>
                </>
              )}
            </Stack>
          </>
        )}
        {notice && (
          <Text size="sm" role="status">
            {notice}
          </Text>
        )}
        <Group
          gap="md"
          wrap="nowrap"
          align="flex-start"
          className="account-trust"
        >
          <IconShieldCheck size={18} className="account-muted-icon" />
          <Text size="sm" c="dimmed">
            Projects and conversations stay on this computer. Your coding agents
            keep their own sign-in.
          </Text>
        </Group>
      </Stack>
    </Paper>
  );
}
