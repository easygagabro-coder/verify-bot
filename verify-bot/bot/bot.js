import {
  Client,
  GatewayIntentBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  Events,
} from "discord.js";
import "dotenv/config";

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

const VERIFY_URL = process.env.DISCORD_REDIRECT_URI.replace(
  "/callback",
  "/verify"
);

client.once(Events.ClientReady, () => {
  console.log(`봇 로그인: ${client.user.tag}`);
});

// 슬래시 커맨드로 인증 패널 전송: /인증패널
client.on(Events.InteractionCreate, async (interaction) => {
  if (interaction.isChatInputCommand() && interaction.commandName === "인증패널") {
    const embed = new EmbedBuilder()
      .setTitle("Verify to access this server")
      .setDescription(
        "This server is protected. Click the button below to verify."
      )
      .setColor(0x2ecc71);

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setLabel("Verify my account")
        .setStyle(ButtonStyle.Link)
        .setURL(VERIFY_URL)
    );

    await interaction.reply({ embeds: [embed], components: [row] });
  }
});

client.login(process.env.DISCORD_BOT_TOKEN);
