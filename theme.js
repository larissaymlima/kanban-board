// Compartilha a preferência de tema entre as páginas e oferece um controle acessível.

// Aplica o tema salvo e configura o botão presente na página atual, se houver.
const themeButton = document.querySelector("[data-theme-toggle]");
const savedTheme = localStorage.getItem("trilha-theme");
document.documentElement.dataset.theme = savedTheme === "dark" ? "dark" : "light";

// Mantém ícone e rótulo acessível sincronizados com o tema ativo.
function updateThemeButton() {
  if (!themeButton) return;
  const isDark = document.documentElement.dataset.theme === "dark";
  themeButton.textContent = isDark ? "☀️ Tema claro" : "🌙 Tema escuro";
  themeButton.setAttribute("aria-label", isDark ? "Ativar tema claro" : "Ativar tema escuro");
  themeButton.setAttribute("aria-pressed", String(isDark));
}

// Alterna o esquema de cores e persiste a escolha para a próxima visita.
themeButton?.addEventListener("click", () => {
  const nextTheme = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = nextTheme;
  localStorage.setItem("trilha-theme", nextTheme);
  updateThemeButton();
});

updateThemeButton();
