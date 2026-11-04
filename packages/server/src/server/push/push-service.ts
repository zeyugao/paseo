import type pino from "pino";

export interface PushPayload {
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

interface ExpoPushTicket {
  status: "ok" | "error";
  id?: string;
  message?: string;
  details?: { error?: string };
}

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";

/** Hosts may register devices from different Expo projects, which cannot share a request. */
export class PushService {
  private readonly logger: pino.Logger;
  private readonly revokeToken: (token: string) => void;

  constructor(logger: pino.Logger, revokeToken: (token: string) => void) {
    this.logger = logger.child({ component: "push-service" });
    this.revokeToken = revokeToken;
  }

  async sendPush(tokens: string[], payload: PushPayload): Promise<void> {
    await Promise.all(tokens.map((token) => this.sendToToken(token, payload)));
  }

  private async sendToToken(token: string, payload: PushPayload): Promise<void> {
    try {
      const response = await fetch(EXPO_PUSH_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          to: token,
          title: payload.title,
          body: payload.body,
          data: payload.data,
          sound: "default",
        }),
      });

      if (!response.ok) {
        this.logger.error(
          { status: response.status, statusText: response.statusText },
          "Expo push API error",
        );
        return;
      }

      const result = (await response.json()) as { data: ExpoPushTicket };
      this.handleTicket(token, result.data);
    } catch (error) {
      this.logger.error({ err: error }, "Failed to send push notifications");
    }
  }

  private handleTicket(token: string, ticket: ExpoPushTicket): void {
    if (ticket.status !== "error") return;

    this.logger.error(
      { token, message: ticket.message, details: ticket.details },
      "Push failed for token",
    );

    if (
      ticket.details?.error === "DeviceNotRegistered" ||
      ticket.details?.error === "InvalidCredentials"
    ) {
      this.revokeToken(token);
    }
  }
}
