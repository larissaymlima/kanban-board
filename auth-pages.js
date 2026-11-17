// Importa os serviços Firebase e utilitários compartilhados de autenticação.
import { auth, db } from "./firebase-config.js";
import { getAuthErrorMessage, redirectIfAuthenticated, setMessage } from "./auth.js";
// Importa as operações de autenticação usadas pelos formulários.
import {
  createUserWithEmailAndPassword,
  deleteUser,
  signInWithEmailAndPassword,
  updateProfile
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
// Importa as operações Firestore para gravar perfil e consentimento LGPD.
import {
  doc,
  serverTimestamp,
  setDoc
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

function getPostAuthDestination() {
  const returnUrl = new URLSearchParams(window.location.search).get("returnUrl");
  if (!returnUrl) return "board.html";

  let destination;
  try {
    destination = new URL(returnUrl, window.location.origin);
  } catch (error) {
    console.warn("O endereço de retorno solicitado é inválido:", error);
    return "board.html";
  }

  const isStaticTaskRoute =
    /(?:^|\/)board\.html$/.test(destination.pathname) &&
    destination.searchParams.get("taskId");
  const isRewrittenTaskRoute =
    /(?:^|\/)tasks\/[^/]+\/?$/.test(destination.pathname);
  if (destination.origin !== window.location.origin ||
      (!isStaticTaskRoute && !isRewrittenTaskRoute) ||
      !destination.searchParams.get("boardId")) return "board.html";

  return `${destination.pathname}${destination.search}${destination.hash}`;
}

// Configura o formulário de login quando a página contém seus controles.
function setupLoginForm() {
  const postAuthDestination = getPostAuthDestination();
  redirectIfAuthenticated(postAuthDestination);
  const form = document.getElementById("loginForm");
  const message = document.getElementById("formMessage");

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
        setMessage(message, "Login realizado com sucesso. Abrindo...", "success");
        window.location.replace(postAuthDestination);
      } catch (error) {
        console.error("Erro ao entrar com Firebase Authentication:", error);
        setMessage(message, getAuthErrorMessage(error), "error");
        submitButton.disabled = false;
      }
    });
  }
}

// Configura o formulário de cadastro quando a página contém seus controles.
function setupCadastroForm() {
  const postAuthDestination = getPostAuthDestination();
  redirectIfAuthenticated(postAuthDestination);
  const form = document.getElementById("cadastroForm");
  const message = document.getElementById("formMessage");
  const emailInput = document.getElementById("cadastroEmail");
  const consentInput = document.getElementById("lgpdConsent");

  if (form && message && emailInput && consentInput) {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();

      const name = document.getElementById("name").value.trim();
      const email = emailInput.value.trim();
      const password = document.getElementById("cadastroPassword").value;

      if (!name || !email || !password) {
        setMessage(message, "Preencha todos os campos para concluir o cadastro.", "error");
        return;
      }

      if (emailInput.validity.typeMismatch) {
        setMessage(message, "Informe um e-mail válido, como nome@exemplo.com.", "error");
        emailInput.focus();
        return;
      }

      if (password.length < 6) {
        setMessage(message, "A senha deve conter pelo menos 6 caracteres.", "error");
        return;
      }

      if (!consentInput.checked) {
        setMessage(message, "Confirme o consentimento para o tratamento dos dados pessoais.", "error");
        consentInput.focus();
        return;
      }

      const submitButton = form.querySelector('[type="submit"]');
      submitButton.disabled = true;
      setMessage(message, "Criando sua conta...", "success");

      let createdUser;
      try {
        const credential = await createUserWithEmailAndPassword(auth, email, password);
        createdUser = credential.user;
        await updateProfile(createdUser, { displayName: name });
        await setDoc(doc(db, "users", createdUser.uid), {
          name,
          lgpdConsent: true,
          consentAt: serverTimestamp(),
          createdAt: serverTimestamp()
        });

        setMessage(message, "Cadastro realizado com sucesso. Abrindo...", "success");
        window.location.replace(postAuthDestination);
      } catch (error) {
        console.error("Erro ao criar conta ou salvar perfil no Firebase:", error);

        if (createdUser) {
          try {
            await deleteUser(createdUser);
          } catch (rollbackError) {
            console.error("Não foi possível desfazer a criação incompleta da conta:", rollbackError);
            setMessage(
              message,
              "A conta foi criada, mas não foi possível salvar o perfil no Firestore nem desfazer a criação. Tente entrar e contate o responsável pelo site.",
              "error"
            );
            submitButton.disabled = false;
            return;
          }
        }

        setMessage(message, getAuthErrorMessage(error), "error");
        submitButton.disabled = false;
      }
    });
  }
}

if (document.getElementById("loginForm")) {
  setupLoginForm();
} else if (document.getElementById("cadastroForm")) {
  setupCadastroForm();
}
