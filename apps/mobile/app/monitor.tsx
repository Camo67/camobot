import { Stack, useFocusEffect } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { NativeActionButton } from "../components/native-action-button";
import { SettingsGroup, SettingsRow } from "../components/settings-group";
import { trailingHeaderOptions } from "../components/sheet-header";
import { formatActivityRelativeTime } from "../lib/activity";
import { mobileTokens } from "../lib/appearance";
import { useI18n } from "../lib/i18n";
import type { MonitorSettings, MonitorStatus } from "../lib/monitor";
import {
  fetchMonitorStatus,
  loadMonitorSettings,
  MONITOR_REFRESH_MS,
  monitorAppDetail,
  monitorStateColor,
  monitorSummary,
  normalizeMonitorUrl,
  saveMonitorSettings,
} from "../lib/monitor";
import { native, useMobileTokens, useThemedStyles } from "../lib/native";

function StatusDot({ color, label }: { color: string; label: string }) {
  return (
    <View
      accessibilityLabel={label}
      style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: color, marginStart: 8 }}
    />
  );
}

export default function MonitorScreen() {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const styles = useThemedStyles(createStyles);
  const [settings, setSettings] = useState<MonitorSettings | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [urlDraft, setUrlDraft] = useState("");
  const [tokenDraft, setTokenDraft] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [status, setStatus] = useState<MonitorStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const inFlight = useRef(false);

  useEffect(() => {
    void loadMonitorSettings().then((saved) => {
      setSettings(saved);
      setUrlDraft(saved?.url ?? "");
      setEditing(!saved);
      setLoaded(true);
    });
  }, []);

  const refresh = useCallback(async (current: MonitorSettings | null) => {
    if (!current || inFlight.current) return;
    inFlight.current = true;
    try {
      const result = await fetchMonitorStatus(current);
      if (result.ok) {
        setStatus(result.status);
        setError(null);
      } else {
        setError(result.error);
        if (result.unauthorized) setEditing(true);
      }
    } finally {
      inFlight.current = false;
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      if (!settings || editing) return;
      void refresh(settings);
      const timer = setInterval(() => void refresh(settings), MONITOR_REFRESH_MS);
      return () => clearInterval(timer);
    }, [settings, editing, refresh]),
  );

  async function save() {
    const parsed = normalizeMonitorUrl(urlDraft);
    if (!parsed.ok) {
      setFormError(parsed.error);
      return;
    }
    const token = tokenDraft.trim() || settings?.token || "";
    if (!token) {
      setFormError(t("Enter the token"));
      return;
    }
    const next = { url: parsed.url, token };
    try {
      await saveMonitorSettings(next);
    } catch {
      setFormError(t("Something went wrong. Try again."));
      return;
    }
    setTokenDraft("");
    setFormError(null);
    setSettings(next);
    setStatus(null);
    setEditing(false);
  }

  const header = editing
    ? trailingHeaderOptions(t("Save"), () => void save())
    : trailingHeaderOptions(t("Settings"), () => setEditing(true));

  if (!loaded) {
    return (
      <View style={[styles.screen, styles.centered]}>
        <ActivityIndicator color={native.secondaryLabel} />
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <Stack.Screen options={{ title: t("Monitor"), ...header }} />
      <ScrollView
        contentContainerStyle={styles.content}
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        refreshControl={
          editing ? undefined : (
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => {
                setRefreshing(true);
                void refresh(settings).finally(() => setRefreshing(false));
              }}
              tintColor={native.secondaryLabel}
              colors={[tokens.mutedForeground]}
              progressBackgroundColor={tokens.muted}
            />
          )
        }
      >
        {editing ? (
          <View>
            <TextInput
              accessibilityLabel={t("Server")}
              autoCapitalize="none"
              autoComplete="off"
              autoCorrect={false}
              keyboardType="url"
              onChangeText={(value) => {
                setUrlDraft(value);
                setFormError(null);
              }}
              placeholder="http://host:8790"
              placeholderTextColor={tokens.mutedForeground}
              style={styles.input}
              textContentType="URL"
              value={urlDraft}
            />
            <TextInput
              accessibilityLabel={t("Token")}
              autoCapitalize="none"
              autoComplete="off"
              autoCorrect={false}
              onChangeText={(value) => {
                setTokenDraft(value);
                setFormError(null);
              }}
              onSubmitEditing={() => void save()}
              placeholder={settings ? t("Unchanged") : t("Token")}
              placeholderTextColor={tokens.mutedForeground}
              returnKeyType="go"
              secureTextEntry
              style={styles.input}
              value={tokenDraft}
            />
            {formError || error ? <Text style={styles.error}>{formError ?? error}</Text> : null}
            {settings ? (
              <NativeActionButton
                label={t("Cancel")}
                onPress={() => {
                  setEditing(false);
                  setFormError(null);
                  setUrlDraft(settings.url);
                  setTokenDraft("");
                }}
                prominence="plain"
                style={{ marginTop: 20, alignSelf: "center" }}
              />
            ) : null}
          </View>
        ) : (
          <>
            {status ? <Text style={styles.summary}>{monitorSummary(status)}</Text> : null}
            {error ? <Text style={styles.error}>{error}</Text> : null}
            {!status && !error ? (
              <ActivityIndicator color={native.secondaryLabel} style={{ marginTop: 24 }} />
            ) : null}
            {status?.clients.map((client) => (
              <SettingsGroup key={client.client} label={client.client}>
                {client.apps.map((app) => (
                  <SettingsRow
                    accessible
                    key={app.name}
                    title={app.name}
                    detail={monitorAppDetail(app)}
                    dimmed={app.state === "disabled"}
                    trailing={
                      <StatusDot color={monitorStateColor(app.state, tokens)} label={app.state} />
                    }
                  />
                ))}
              </SettingsGroup>
            ))}
            {status ? (
              <>
                <SettingsGroup label={t("Agents")}>
                  <SettingsRow
                    accessible
                    key="handovers"
                    title={t("Open handovers")}
                    value={String(status.handovers.open)}
                  />
                  {status.agents.map((agent) => (
                    <SettingsRow
                      accessible
                      key={agent.name}
                      title={agent.name}
                      detail={agent.sub}
                      trailing={
                        <StatusDot
                          color={monitorStateColor(agent.active, tokens)}
                          label={agent.active}
                        />
                      }
                    />
                  ))}
                </SettingsGroup>
                <SettingsGroup label={t("Machines")}>
                  {status.machines.map((machine) => (
                    <SettingsRow
                      accessible
                      key={machine.name}
                      title={machine.name}
                      detail={
                        machine.online
                          ? t("Online")
                          : machine.last_seen
                            ? formatActivityRelativeTime(machine.last_seen)
                            : t("Offline")
                      }
                      trailing={
                        <StatusDot
                          color={monitorStateColor(machine.online ? "online" : "offline", tokens)}
                          label={machine.online ? t("Online") : t("Offline")}
                        />
                      }
                    />
                  ))}
                </SettingsGroup>
              </>
            ) : null}
          </>
        )}
      </ScrollView>
    </View>
  );
}

function createStyles() {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: native.groupedPage },
    centered: { alignItems: "center", justifyContent: "center" },
    content: { flexGrow: 1, paddingHorizontal: 16, paddingTop: 16, paddingBottom: 32 },
    summary: { color: native.secondaryLabel, fontSize: 15, marginBottom: 8, marginHorizontal: 4 },
    error: { color: mobileTokens().destructive, fontSize: 14, marginTop: 12, marginHorizontal: 4 },
    input: {
      marginTop: 12,
      backgroundColor: native.groupedCell,
      borderRadius: 13,
      padding: 16,
      color: native.label,
      fontSize: 16,
    },
  });
}
