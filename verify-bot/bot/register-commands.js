import { REST, Routes, SlashCommandBuilder } from "discord.js";
import "dotenv/config";

const commands = [
  new SlashCommandBuilder()
    .setName("인증패널")
    .setDescription("인증 버튼 임베드를 이 채널에 전송합니다.")
    .toJSON(),
];

const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_BOT_TOKEN);

try {
  await rest.put(
    Routes.applicationGuildCommands(
      process.env.DISCORD_CLIENT_ID,
      process.env.GUILD_ID
    ),
    { body: commands }
  );
  console.log("슬래시 커맨드 등록 완료");
} catch (err) {
  console.error(err);
}
