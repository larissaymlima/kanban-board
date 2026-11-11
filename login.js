// Importa os serviços Firebase e utilitários compartilhados de autenticação.
import { auth } from "./firebase-config.js";
import { getAuthErrorMessage, redirectIfAuthenticated, setMessage } from "./auth.js";
// Importa a operação de login por e-mail e senha.
import { signInWithEmailAndPassword } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";

// Redireciona usuários com sessão ativa e configura o formulário de login.
redirectIfAuthenticated();
const form = document.getElementById("loginForm");
const message = document.getElementById("formMessage");

// Evita registrar eventos se o HTML não tiver os controles esperados.
if (form && message) {
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const email = document.getElementById("email").value.trim();
    const password = document.getElementById("password").value;

    if (!email || !password) {
      setMessage(message, "Preencha todos os campos antes de entrar.", "error");
      return;
    }

    const submitButton = form.querySelector('[type="submit"]');
    submitButton.disabled = true;
    setMessage(message, "Entrando...", "success");

    try {
      await signInWithEmailAndPassword(auth, email, password);
      setMessage(message, "Login realizado com sucesso. Abrindo seu quadro...", "success");
      window.location.replace("board.html");
    } catch (error) {
      console.error("Erro ao entrar com Firebase Authentication:", error);
      setMessage(message, getAuthErrorMessage(error), "error");
      submitButton.disabled = false;
    }
  });
}
