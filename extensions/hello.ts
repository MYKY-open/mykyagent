export default function(pi) {
  pi.on("session_start", async () => {
    console.log("[MykyAgent] Extension initialized successfully!");
  });
}
