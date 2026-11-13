// Importa os serviços Firebase compartilhados pelos módulos do site.
import { auth } from "./firebase-config.js";
// Importa o observador de sessão do Firebase Authentication.
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

// Exibe uma mensagem junto ao formulário e aplica sua classe visual.
export function setMessage(element, text, type = "error") {
  if (!element) return;
  element.textContent = text;
  element.classList.remove("success", "error");
  element.classList.add(type);
}

// Redireciona para o quadro quando o Firebase confirma uma sessão válida.
export function getPostLoginUrl() {
  // Aceita somente rotas locais conhecidas para impedir redirecionamentos externos.
  const returnUrl = sessionStorage.getItem("trilha-return-url");
  if (returnUrl && /^(task|board)\.html\?/.test(returnUrl)) {
    sessionStorage.removeItem("trilha-return-url");
    return returnUrl;
  }
  return "board.html";
}

// Redireciona para o destino solicitado depois que o Firebase confirma a sessão.
export function redirectIfAuthenticated(targetPage) {
  const unsubscribe = onAuthStateChanged(auth, (user) => {
    unsubscribe();
    if (user) window.location.replace(targetPage || getPostLoginUrl());
  });
}

// Converte erros comuns do Firebase em mensagens compreensíveis.
export function getAuthErrorMessage(error) {
  const messages = {
    "auth/email-already-in-use": "Este e-mail já está cadastrado. Tente fazer login.",
    "auth/invalid-email": "Informe um endereço de e-mail válido.",
    "auth/invalid-credential": "E-mail ou senha inválidos.",
    "auth/user-disabled": "Esta conta está desativada.",
    "auth/weak-password": "A senha deve conter pelo menos 6 caracteres.",
    "auth/network-request-failed": "Falha de conexão. Verifique sua internet e tente novamente.",
    "auth/too-many-requests": "Muitas tentativas. Aguarde um pouco e tente novamente.",
    "auth/operation-not-allowed": "O login por e-mail e senha não está habilitado no Firebase.",
    "permission-denied": "O Firestore bloqueou o acesso. Publique as regras do arquivo firestore.rules.",
    "unavailable": "O Firebase está temporariamente indisponível. Verifique sua conexão e tente novamente.",
    "not-found": "O banco Firestore ainda não foi criado neste projeto Firebase."
  };
  return messages[error.code] || "Não foi possível concluir a operação. Tente novamente.";
}

// Alterna os campos de senha entre texto visível e senha mascarada.
document.querySelectorAll("[data-password-toggle]").forEach((button) => {
  const input = document.getElementById(button.getAttribute("data-password-toggle"));
  if (!input) return;

  button.addEventListener("click", () => {
    const showPassword = input.type === "password";
    input.type = showPassword ? "text" : "password";
    button.textContent = showPassword ? "Ocultar" : "Mostrar";
    button.setAttribute("aria-label", showPassword ? "Ocultar senha" : "Mostrar senha");
  });
});
