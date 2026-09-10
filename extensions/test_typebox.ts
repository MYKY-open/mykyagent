import { Type } from "@sinclair/typebox";
export default function(pi) {
  pi.registerTool({
    name: "ping",
    label: "Ping",
    description: "Ping tool",
    parameters: Type.Object({
      msg: Type.String()
    }),
    async execute(_id, { msg }) {
      return { content: [{ type: "text", text: "pong: " + msg }] };
    }
  });
}
