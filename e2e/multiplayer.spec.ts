import { expect, test, type Page } from "@playwright/test";

type WireMessage = Record<string, unknown> & { type?: string };

function isWireMessage(value: unknown): value is WireMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    typeof value.type === "string"
  );
}

function captureWebSocketMessages(page: Page): WireMessage[] {
  const messages: WireMessage[] = [];
  page.on("websocket", (socket) => {
    if (!socket.url().endsWith("/ws")) return;
    socket.on("framereceived", ({ payload }) => {
      if (typeof payload !== "string") return;
      try {
        const parsed: unknown = JSON.parse(payload);
        if (isWireMessage(parsed)) messages.push(parsed);
      } catch {
        // Binary frames are not used in this test.
      }
    });
  });
  return messages;
}

async function joinRoom(page: Page, roomId: string, playerName: string) {
  await page.goto("/");
  await expect(page.locator("#joinForm")).toBeVisible({ timeout: 15_000 });
  await page.locator('#joinForm [name="playerName"]').fill(playerName);
  await page.locator('#joinForm [name="roomId"]').selectOption(roomId);
  await page.getByRole("button", { name: "Join game" }).click();
  await expect(page.locator("#chatForm")).toBeVisible();
}

test("two browser clients see authoritative movement and receive room chat", async ({
  browser,
  request,
}) => {
  const roomId = `e2e-${Date.now().toString(36)}`;
  const response = await request.post("/api/rooms", {
    data: { id: roomId, name: "Playwright room", capacity: 16 },
  });
  expect(response.status()).toBe(201);

  const firstContext = await browser.newContext();
  const secondContext = await browser.newContext();
  const first = await firstContext.newPage();
  const second = await secondContext.newPage();
  const firstMessages = captureWebSocketMessages(first);
  const secondMessages = captureWebSocketMessages(second);

  try {
    await joinRoom(first, roomId, "Pilot One");
    await expect
      .poll(
        () =>
          firstMessages.some(
            (message) =>
              message.type === "snapshot" &&
              Array.isArray(message.entities) &&
              message.entities.some(
                (entity) =>
                  typeof entity === "object" &&
                  entity !== null &&
                  "kind" in entity &&
                  entity.kind === "ship",
              ),
          ),
        { timeout: 10_000 },
      )
      .toBe(true);

    await joinRoom(second, roomId, "Pilot Two");
    await expect
      .poll(
        () =>
          firstMessages.some(
            (message) =>
              message.type === "player-joined" &&
              typeof message.player === "object" &&
              message.player !== null &&
              "name" in message.player &&
              message.player.name === "Pilot Two",
          ),
        { timeout: 10_000 },
      )
      .toBe(true);

    const firstJoined = firstMessages.find((message) => message.type === "joined");
    expect(firstJoined).toBeDefined();
    const player = firstJoined?.player;
    expect(typeof player).toBe("object");
    if (typeof player !== "object" || player === null || !("entityId" in player)) {
      throw new Error("First browser did not receive its player identity.");
    }
    const entityId = player.entityId;

    const findRemotePosition = () => {
      const snapshots = secondMessages.filter(
        (message) =>
          message.type === "snapshot" && Array.isArray(message.entities),
      );
      for (let index = snapshots.length - 1; index >= 0; index -= 1) {
        const entities = snapshots[index]?.entities;
        if (!Array.isArray(entities)) continue;
        const ship = entities.find(
          (entity) =>
            typeof entity === "object" &&
            entity !== null &&
            "id" in entity &&
            entity.id === entityId &&
            "kind" in entity &&
            entity.kind === "ship",
        );
        if (
          typeof ship === "object" &&
          ship !== null &&
          "x" in ship &&
          "y" in ship &&
          typeof ship.x === "number" &&
          typeof ship.y === "number"
        ) {
          return { x: ship.x, y: ship.y };
        }
      }
      return null;
    };

    await expect.poll(findRemotePosition, { timeout: 10_000 }).not.toBeNull();
    const before = findRemotePosition();
    expect(before).not.toBeNull();

    await first.keyboard.down("ArrowUp");
    await first.waitForTimeout(600);
    await first.keyboard.up("ArrowUp");

    await expect
      .poll(
        () => {
          const current = findRemotePosition();
          return current && before
            ? Math.hypot(current.x - before.x, current.y - before.y)
            : 0;
        },
        { timeout: 10_000 },
      )
      .toBeGreaterThan(1);

    await first.locator("#chatInput").fill("Lab 7 multiplayer check");
    await first.locator('#chatForm button[type="submit"]').click();
    await expect(second.locator("#chatMessages")).toContainText(
      "Pilot One: Lab 7 multiplayer check",
      { timeout: 10_000 },
    );

    await first.getByRole("button", { name: "Start 8 Worker bots" }).click();
    await expect(first.locator("#botStatus")).toHaveText(
      "8/8 Worker bots connected",
      { timeout: 10_000 },
    );
    await first.getByRole("button", { name: "Stop Worker bots" }).click();
    await expect(first.locator("#botStatus")).toHaveText("Worker bots stopped.");
  } finally {
    await firstContext.close();
    await secondContext.close();
  }
});
