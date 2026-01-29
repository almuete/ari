export function getBossGreeting(now = new Date()): string {
  const h = now.getHours();
  const timeOfDay =
    h < 12 ? "morning" : h < 17 ? "afternoon" : h < 22 ? "evening" : "night";

  const variants = [
    // Classic
    `Good ${timeOfDay}, boss.`,
    `Welcome back, boss. Good ${timeOfDay}.`,
    `Good ${timeOfDay}, boss. Ready when you are.`,

    // Friendly & warm
    `Hope you're having a great ${timeOfDay}, boss.`,
    `Nice to see you, boss. Good ${timeOfDay}.`,
    `Hey boss, good ${timeOfDay}!`,

    // Professional & confident
    `All set, boss. Good ${timeOfDay}.`,
    `Good ${timeOfDay}, boss. Everything is ready.`,
    `Standing by, boss. Have a great ${timeOfDay}.`,

    // Light motivation
    `Let’s make this ${timeOfDay} productive, boss.`,
    `Another strong ${timeOfDay} ahead, boss.`,
    `Ready to win this ${timeOfDay}, boss?`,

    // Late-night friendly
    `Still going strong tonight, boss.`,
    `Good night, boss. Let me know if you need anything.`,
  ];

  return variants[Math.floor(Math.random() * variants.length)]!;
}

