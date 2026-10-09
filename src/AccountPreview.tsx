import { useEffect, useState } from "react";
import { useReducedMotion } from "@mantine/hooks";
import {
  Alert,
  Avatar,
  Badge,
  Button,
  Divider,
  Group,
  Modal,
  Paper,
  SegmentedControl,
  Select,
  Stack,
  Switch,
  Text,
  Title,
} from "@mantine/core";
import {
  IconArrowRight,
  IconCheck,
  IconCloudCheck,
  IconFolder,
  IconHistory,
  IconRefresh,
  IconShieldCheck,
  IconWifiOff,
} from "@tabler/icons-react";
import wordmark from "../assets/palisade-wordmark-darkmode-no-bg.png";
import lightWordmark from "../assets/palisade-wordmark-lightmode-no-bg.png";
import "./AccountGate.css";
import AccountSignIn from "./AccountSignIn";

type Stage = "sign-in" | "waiting" | "error" | "import" | "profile" | "expired";
type Profile = {
  name: string;
  email: string;
  initials: string;
  projects: string[];
  theme: string;
  font: string;
  notifications: boolean;
  imported: boolean;
};
const initialProfiles: Profile[] = [
  {
    name: "Alex Morgan",
    email: "alex@example.com",
    initials: "AM",
    projects: [],
    theme: "dark",
    font: "System monospace",
    notifications: true,
    imported: false,
  },
  {
    name: "Jamie Chen",
    email: "jamie@example.com",
    initials: "JC",
    projects: ["Studio website"],
    theme: "light",
    font: "Menlo",
    notifications: false,
    imported: true,
  },
];

// Mock-only preview: no credentials, filesystem writes, or real restart.
export default function AccountPreview() {
  const reducedMotion = useReducedMotion();
  const [stage, setStage] = useState<Stage>("sign-in");
  const [profiles, setProfiles] = useState(initialProfiles);
  const [active, setActive] = useState(0);
  const [offline, setOffline] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [dirty, setDirty] = useState(true);
  const [running, setRunning] = useState(true);
  const [restart, setRestart] = useState(false);
  const [claim, setClaim] = useState<number | null>(null);
  const [notice, setNotice] = useState("");
  const [expiry] = useState(() =>
    new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    })
  );
  const profile = profiles[active];
  const theme =
    profile.theme === "auto"
      ? window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : profile.theme;
  useEffect(() => {
    const root = document.documentElement;
    const previousTheme = root.getAttribute("data-theme");
    const previousScheme = root.getAttribute("data-mantine-color-scheme");
    root.setAttribute("data-theme", theme);
    root.setAttribute("data-mantine-color-scheme", theme);
    return () => {
      if (previousTheme) root.setAttribute("data-theme", previousTheme);
      else root.removeAttribute("data-theme");
      if (previousScheme)
        root.setAttribute("data-mantine-color-scheme", previousScheme);
      else root.removeAttribute("data-mantine-color-scheme");
    };
  }, [theme]);
  useEffect(() => {
    document.querySelector<HTMLElement>(".account-preview h1")?.focus();
    const preview = document.querySelector(".account-preview");
    if (preview) preview.scrollTop = 0;
  }, [stage]);
  const update = (values: Partial<Profile>) =>
    setProfiles(
      profiles.map((p, index) => (index === active ? { ...p, ...values } : p))
    );
  const completeLogin = () => {
    setOffline(false);
    setStage(!profile.imported && claim === null ? "import" : "profile");
  };
  const changeAccount = () => {
    setSwitching(false);
    setRestart(true);
    setStage("sign-in");
    setActive(active === 0 ? 1 : 0);
    setNotice("");
    setOffline(false);
  };

  return (
    <main
      className="account-preview"
      data-stage={stage}
      data-theme={profile.theme === "auto" ? undefined : profile.theme}
    >
      <div className="account-preview-body" inert={switching}>
        <div className="account-preview-tools">
          <Group gap="md">
            <Badge color="warn" variant="light">
              UI preview · mock data
            </Badge>
            <Text size="sm" c="dimmed">
              No account or local files are changed.
            </Text>
          </Group>
          <Group gap="sm">
            <Button
              size="xs"
              variant="subtle"
              onClick={() => {
                setStage("sign-in");
                setRestart(false);
                setNotice("");
              }}
            >
              Sign-in
            </Button>
            <Button
              size="xs"
              variant="subtle"
              onClick={() => {
                setStage("profile");
                setRestart(false);
              }}
            >
              Profile
            </Button>
            <Button
              size="xs"
              variant="subtle"
              onClick={() => {
                setStage("expired");
                setRestart(false);
              }}
            >
              Expired session
            </Button>
          </Group>
        </div>
        <div className="account-preview-content">
          <header className="account-brand">
            <img
              src={theme === "light" ? lightWordmark : wordmark}
              alt="Palisade"
            />
            <Text size="sm" c="dimmed">
              Your agents. Your workspace.
            </Text>
          </header>
          {(stage === "sign-in" ||
            stage === "waiting" ||
            stage === "error") && (
            <AccountSignIn
              stage={stage}
              onStart={() => {
                setStage("waiting");
                setNotice("");
              }}
              onReopen={() =>
                setNotice("The browser would reopen to Clerk sign-in.")
              }
              onCancel={() => {
                setStage("sign-in");
                setNotice("");
              }}
              notice={notice}
              restartNotice={
                restart
                  ? "Restart simulated. Your previous profile is safely kept."
                  : undefined
              }
              previewControls={
                <>
                  <Divider label="Preview controls" />
                  <Group grow>
                    <Button onClick={completeLogin}>
                      Simulate successful sign-in
                    </Button>
                    <Button variant="default" onClick={() => setStage("error")}>
                      Simulate failure
                    </Button>
                  </Group>
                </>
              }
            />
          )}
          {stage === "import" && (
            <Paper className="account-card" withBorder radius="lg">
              <Stack gap={24}>
                <Badge variant="light" w="fit-content">
                  One-time setup
                </Badge>
                <div>
                  <Title order={1} tabIndex={-1}>
                    Bring your workspace along.
                  </Title>
                  <Text className="account-description">
                    We found existing Palisade work on this computer. Add it to{" "}
                    {profile.name}’s profile, or begin with a clean slate.
                  </Text>
                </div>
                <div className="account-import-summary">
                  <Group>
                    <IconFolder size={20} />
                    <div>
                      <Text fw={600}>3 local projects</Text>
                      <Text size="sm" c="dimmed">
                        Palisade Code · Design system · Personal website
                      </Text>
                    </div>
                  </Group>
                  <Group>
                    <IconHistory size={20} />
                    <div>
                      <Text fw={600}>
                        12 conversations & workspace preferences
                      </Text>
                      <Text size="sm" c="dimmed">
                        Open tabs, editor settings, and notifications
                      </Text>
                    </div>
                  </Group>
                </div>
                <Alert color="success" icon={<IconShieldCheck size={18} />}>
                  A recovery copy is kept before importing. Source repositories
                  stay in place.
                </Alert>
                <Button
                  rightSection={<IconArrowRight size={16} />}
                  onClick={() => {
                    update({
                      projects: [
                        "Palisade Code",
                        "Design system",
                        "Personal website",
                      ],
                      imported: true,
                    });
                    setClaim(active);
                    setStage("profile");
                    setNotice(
                      "Workspace imported. A recovery copy was kept (simulated)."
                    );
                  }}
                >
                  Import into this profile
                </Button>
                <Button
                  variant="subtle"
                  onClick={() => {
                    setStage("profile");
                    setNotice(
                      "Fresh profile created. Existing work remains available to import."
                    );
                  }}
                >
                  Start fresh
                </Button>
                <Text size="sm" c="dimmed" ta="center">
                  Signed in as {profile.email}
                </Text>
              </Stack>
            </Paper>
          )}
          {stage === "expired" && (
            <Paper className="account-card" withBorder radius="lg">
              <Stack gap={24}>
                <div className="account-symbol">
                  <IconWifiOff size={24} />
                </div>
                <div>
                  <Title order={1} tabIndex={-1}>
                    Let’s verify your account.
                  </Title>
                  <Text className="account-description">
                    Your offline access has expired. Connect to the internet and
                    sign in to continue working.
                  </Text>
                </div>
                <Alert color="warn" title="Your work is still here">
                  Unsaved files can be saved. Running agents can finish or be
                  safely stopped. New work waits until your account is verified.
                </Alert>
                <Button
                  onClick={() => setStage("waiting")}
                  leftSection={<IconRefresh size={16} />}
                >
                  Verify in browser
                </Button>
                <Button
                  variant="default"
                  onClick={() =>
                    setNotice(
                      "Unsaved files saved in this preview. No real files were written."
                    )
                  }
                >
                  Save current work
                </Button>
                {notice && <Text role="status">{notice}</Text>}
              </Stack>
            </Paper>
          )}
          {stage === "profile" && (
            <Paper
              className="account-profile-card"
              withBorder
              radius="lg"
              p={24}
            >
              <Stack gap={24}>
                <Group justify="space-between">
                  <div>
                    <Text className="account-eyebrow">Local profile</Text>
                    <Title order={1} tabIndex={-1}>
                      Your profile
                    </Title>
                  </div>
                  <Badge
                    color={offline ? "warn" : "success"}
                    variant="light"
                    leftSection={
                      offline ? (
                        <IconWifiOff size={13} />
                      ) : (
                        <IconCloudCheck size={13} />
                      )
                    }
                  >
                    {offline ? "Offline" : "Verified online"}
                  </Badge>
                </Group>
                <Group className="account-identity" gap="lg">
                  <Avatar size={56} radius="xl" color="neutral">
                    {profile.initials}
                  </Avatar>
                  <div>
                    <Title order={2}>{profile.name}</Title>
                    <Text c="dimmed">{profile.email}</Text>
                    <Text size="sm" c="dimmed">
                      Local profile on this computer
                    </Text>
                  </div>
                </Group>
                {notice && (
                  <Alert color="success" role="status">
                    {notice}
                  </Alert>
                )}
                <div className="account-profile-columns">
                  <Stack gap="lg">
                    <div>
                      <Title order={3}>Workspace</Title>
                      <Text size="sm" c="dimmed">
                        Pick up where you left off in this profile.
                      </Text>
                    </div>
                    {profile.projects.length ? (
                      profile.projects.map((project) => (
                        <div className="account-project" key={project}>
                          <IconFolder size={18} />
                          <div>
                            <Text fw={600}>{project}</Text>
                            <Text size="sm" c="dimmed">
                              {project === "Palisade Code"
                                ? "3 open tabs · 8 conversations"
                                : "Workspace ready to restore"}
                            </Text>
                          </div>
                        </div>
                      ))
                    ) : (
                      <Text c="dimmed">
                        No projects yet. Your new workspace is ready.
                      </Text>
                    )}
                    {!profile.imported && claim === null && (
                      <Button
                        variant="default"
                        onClick={() => setStage("import")}
                      >
                        Import existing workspace
                      </Button>
                    )}
                    <div className="account-access">
                      <IconShieldCheck size={19} />
                      <div>
                        <Text fw={600}>
                          {offline
                            ? "You can keep working offline"
                            : "Ready for offline work"}
                        </Text>
                        <Text size="sm" c="dimmed">
                          Offline access expires {expiry}.
                        </Text>
                      </div>
                    </div>
                  </Stack>
                  <Stack gap="lg">
                    <div>
                      <Title order={3}>Personal preferences</Title>
                      <Text size="sm" c="dimmed">
                        Remembered separately for each profile.
                      </Text>
                    </div>
                    <div role="group" aria-labelledby="profile-appearance">
                      <Text id="profile-appearance" fw={600} size="sm">
                        Appearance
                      </Text>
                      <SegmentedControl
                        transitionDuration={0}
                        fullWidth
                        value={profile.theme}
                        onChange={(theme) => update({ theme })}
                        data={[
                          { label: "System", value: "auto" },
                          { label: "Light", value: "light" },
                          { label: "Dark", value: "dark" },
                        ]}
                      />
                    </div>
                    <Select
                      label="Editor font"
                      value={profile.font}
                      onChange={(font) => font && update({ font })}
                      data={["System monospace", "Menlo", "Monaco"]}
                      allowDeselect={false}
                    />
                    <Switch
                      label="Notify when an agent finishes"
                      checked={profile.notifications}
                      onChange={(event) =>
                        update({ notifications: event.currentTarget.checked })
                      }
                    />
                  </Stack>
                </div>
                <Divider />
                <Group justify="space-between" align="flex-start">
                  <Text size="sm" c="dimmed" maw={340}>
                    Switching accounts restarts Palisade. Your projects,
                    history, and preferences stay with this profile.
                  </Text>
                  <Group>
                    <Button
                      variant="subtle"
                      onClick={() => {
                        setStage("sign-in");
                        setRestart(false);
                        setNotice("");
                      }}
                    >
                      Sign out
                    </Button>
                    <Button
                      variant="default"
                      onClick={() => {
                        setSwitching(true);
                        setNotice("");
                        setDirty(true);
                        setRunning(true);
                      }}
                    >
                      Switch account
                    </Button>
                  </Group>
                </Group>
                <Divider label="Preview controls" />
                <Switch
                  label="Simulate offline connection"
                  checked={offline}
                  onChange={(event) => setOffline(event.currentTarget.checked)}
                />
              </Stack>
            </Paper>
          )}
        </div>
      </div>
      <Modal
        closeButtonProps={{ "aria-label": "Cancel account switch" }}
        transitionProps={{ duration: reducedMotion ? 0 : 200 }}
        className="account-switch-modal"
        opened={switching}
        onClose={() => setSwitching(false)}
        title="Switch accounts"
        centered
        size="md"
      >
        <Stack gap="lg">
          <Text>
            Let’s leave {profile.name}’s workspace in a good place before
            restarting.
          </Text>
          {dirty ? (
            <Paper withBorder p="lg">
              <Text fw={600}>2 unsaved files</Text>
              <Text size="sm" c="dimmed">
                App.tsx · README.md
              </Text>
              <Group mt="md">
                <Button size="sm" onClick={() => setDirty(false)}>
                  Save all
                </Button>
                <Button
                  size="sm"
                  variant="subtle"
                  color="danger"
                  onClick={() => setDirty(false)}
                >
                  Discard changes
                </Button>
              </Group>
            </Paper>
          ) : (
            <Text c="success">
              <IconCheck size={15} /> Files settled
            </Text>
          )}
          {running ? (
            <Paper withBorder p="lg">
              <Text fw={600}>1 agent is still running</Text>
              <Text size="sm" c="dimmed">
                Your profile stays active until its work is settled.
              </Text>
              <Group mt="md">
                <Button
                  size="sm"
                  variant="default"
                  onClick={() => setRunning(false)}
                >
                  Stop agent safely
                </Button>
                <Button
                  size="sm"
                  variant="subtle"
                  onClick={() =>
                    setNotice(
                      "Waiting for the agent. Simulate completion below."
                    )
                  }
                >
                  Wait for completion
                </Button>
              </Group>
              <Button
                mt="sm"
                size="xs"
                variant="subtle"
                onClick={() => setRunning(false)}
              >
                Simulate agent completion
              </Button>
            </Paper>
          ) : (
            <Text c="success">
              <IconCheck size={15} /> Agent output saved
            </Text>
          )}
          {notice && (
            <Text size="sm" role="status">
              {notice}
            </Text>
          )}
          <Text size="sm" c="dimmed">
            Restart will open sign-in so you can choose another account. Local
            work is kept.
          </Text>
          <Group justify="flex-end">
            <Button variant="subtle" onClick={() => setSwitching(false)}>
              Cancel
            </Button>
            <Button disabled={dirty || running} onClick={changeAccount}>
              Restart & switch
            </Button>
          </Group>
        </Stack>
      </Modal>
    </main>
  );
}
