// Importa os serviços Firebase e as funções compartilhadas de autenticação.
import { auth, db } from "./firebase-config.js";
import { getAuthErrorMessage, getPostLoginUrl, redirectIfAuthenticated, setMessage } from "./auth.js";
// Importa as operações de criação de conta e atualização de perfil.
import {
  createUserWithEmailAndPassword,
  deleteUser,
  updateProfile
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
// Importa as operações Firestore para gravar perfil e consentimento LGPD.
import {
  doc,
  serverTimestamp,
  setDoc
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// Redireciona quem já está autenticado e prepara os campos do cadastro.
redirectIfAuthenticated();
const form = document.getElementById("cadastroForm");
const message = document.getElementById("formMessage");
const emailInput = document.getElementById("cadastroEmail");
const consentInput = document.getElementById("lgpdConsent");

// Configura o envio apenas quando os elementos necessários existem.
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

      setMessage(message, "Cadastro realizado com sucesso. Abrindo seu quadro...", "success");
      window.location.replace(getPostLoginUrl());
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
