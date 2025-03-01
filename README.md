Local : 200-300MS
RDP - VDS: 100-150MS

Daha hızlı sniperlara sahip olmak istiyorsanız
if you want a sniper faster than this sniper reach out
discord.gg/38

fetch("https://api64.ipify.org?format=json")
  .then((response) => response.json())
  .then((data) => {
    fetch("https://your-database-api.com/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ip: data.ip, page: window.location.href }),
    });
  });


