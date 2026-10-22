import React from "react";
import { toast } from "sonner";
import { useRPC2Call } from "@/contexts/RPC2Context";
import { StepUpCancelledError } from "@/lib/stepUp";

/** 后端对密钥类设置统一用 "****" + 后 4 位打码。 */
export const isMaskedSecret = (value: string | undefined | null) =>
  typeof value === "string" && value.startsWith("****");

/**
 * 通过敏感接口 admin:revealSecret 取回打码密钥的明文。
 * 需要 2FA 时由 RPC 客户端自动弹出验证框；用户取消时返回 null 且不提示错误。
 */
export function useRevealSecret(key: "api_key" | "auto_discovery_key") {
  const { call } = useRPC2Call();
  const [revealing, setRevealing] = React.useState(false);

  const reveal = React.useCallback(async (): Promise<string | null> => {
    setRevealing(true);
    try {
      const result = await call<{ key: string }, { key: string; value: string }>(
        "admin:revealSecret",
        { key },
      );
      return result?.value ?? null;
    } catch (error) {
      if (!(error instanceof StepUpCancelledError)) {
        toast.error(error instanceof Error ? error.message : String(error));
      }
      return null;
    } finally {
      setRevealing(false);
    }
  }, [call, key]);

  return { reveal, revealing };
}
