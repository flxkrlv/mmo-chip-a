import { useOnlineUsers } from "../../state/onlineUsers";

const USER_COLORS = [
  "#3aa9ff", "#ff6b6b", "#51cf66", "#fcc419", "#cc5de8",
  "#20c997", "#ff922b", "#748ffc", "#f06595", "#38d9a9"
];

function hashColor(userId: string): string {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    hash = ((hash << 5) - hash) + userId.charCodeAt(i);
    hash |= 0;
  }
  return USER_COLORS[Math.abs(hash) % USER_COLORS.length];
}

export function OnlineUsersPanel() {
  const users = useOnlineUsers((s) => s.users);

  if (users.length === 0) return null;

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "0 4px"
      }}
    >
      {users.map((user) => {
        const color = hashColor(user.userId);
        return (
          <div
            key={user.userId}
            title={
              `${user.username}${user.dieId ? ` — on ${user.dieId.slice(0, 8)}…` : ""}${user.tool ? ` (${user.tool})` : ""}`
            }
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: 22,
              height: 22,
              borderRadius: "50%",
              background: color,
              color: "#fff",
              fontSize: 10,
              fontWeight: 700,
              cursor: "default",
              position: "relative",
              flexShrink: 0
            }}
          >
            {user.username[0].toUpperCase()}
            {/* Dots to indicate activity */}
            <span
              style={{
                position: "absolute",
                bottom: -1,
                right: -1,
                width: 7,
                height: 7,
                borderRadius: "50%",
                background: user.dieId ? "#51cf66" : "#868e96",
                border: "1px solid var(--card)"
              }}
            />
          </div>
        );
      })}
    </div>
  );
}
