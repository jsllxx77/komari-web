import React from "react";
import { Button, Dialog, Flex, Text, TextField } from "@radix-ui/themes";
import { useTranslation } from "react-i18next";
import { subscribeStepUp, type StepUpPrompt } from "@/lib/stepUp";

/**
 * 全局的敏感操作验证码对话框。由 lib/stepUp 的 requestStepUp() 驱动：
 * 需要验证时自动弹出，验证成功或取消后关闭。整个应用只挂载一个。
 */
export default function StepUpDialog() {
  const { t } = useTranslation();
  const [prompt, setPrompt] = React.useState<StepUpPrompt | null>(null);
  const [code, setCode] = React.useState("");
  const [error, setError] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);

  React.useEffect(
    () =>
      subscribeStepUp((next) => {
        setPrompt(next);
        setCode("");
        setError("");
        setSubmitting(false);
      }),
    [],
  );

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!prompt) return;
    const trimmed = code.trim();
    if (!trimmed) {
      setError(t("step_up.code_required"));
      return;
    }
    setSubmitting(true);
    setError("");
    try {
      await prompt.submit(trimmed);
    } catch (err) {
      const message = err instanceof Error ? err.message : "";
      setError(
        message === "Invalid 2FA code"
          ? t("step_up.invalid_code")
          : message || t("step_up.failed"),
      );
      setCode("");
      setSubmitting(false);
    }
  };

  return (
    <Dialog.Root
      open={prompt !== null}
      onOpenChange={(open) => {
        if (!open && prompt && !submitting) prompt.cancel();
      }}
    >
      <Dialog.Content maxWidth="420px" className="km-step-up-dialog">
        <Dialog.Title>{t("step_up.title")}</Dialog.Title>
        <Dialog.Description size="2" mb="3">
          {t("step_up.description")}
        </Dialog.Description>
        <form onSubmit={handleSubmit}>
          <Flex direction="column" gap="2">
            <TextField.Root
              autoFocus
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={10}
              placeholder="000000"
              value={code}
              onChange={(e) => setCode((e.target as HTMLInputElement).value)}
              disabled={submitting}
            />
            {error && (
              <Text size="2" color="red">
                {error}
              </Text>
            )}
            <Flex gap="2" justify="end" mt="2">
              <Button
                type="button"
                variant="soft"
                color="gray"
                disabled={submitting}
                onClick={() => prompt?.cancel()}
              >
                {t("common.cancel")}
              </Button>
              <Button type="submit" disabled={submitting}>
                {submitting ? t("step_up.verifying") : t("step_up.verify")}
              </Button>
            </Flex>
          </Flex>
        </form>
      </Dialog.Content>
    </Dialog.Root>
  );
}
