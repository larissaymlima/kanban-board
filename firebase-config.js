
// Importa a função que inicializa o aplicativo Firebase.
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
// Importa a função que conecta o módulo de autenticação Firebase.
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
// Importa a função que conecta o banco de dados Firestore.
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// Reúne os identificadores públicos necessários para conectar o app web ao projeto Firebase.
const firebaseConfig = {
  // Chave de identificação do projeto Firebase no app web.
  apiKey: "AIzaSyAMFWm-1IdkMmtNS0lJGafed-6FbtrZGlM",
  // Domínio usado pelos fluxos de autenticação do Firebase.
  authDomain: "projeto-kanban-f0e56.firebaseapp.com",
  // Identificador único do projeto Firebase.
  projectId: "projeto-kanban-f0e56",
  // Endereço do bucket usado para armazenar arquivos.
  storageBucket: "projeto-kanban-f0e56.firebasestorage.app",
  // Identificador do remetente usado por serviços de mensagens Firebase.
  messagingSenderId: "333124117756",
  // Identificador deste aplicativo web dentro do projeto.
  appId: "1:333124117756:web:0d9373f063c165ac6f2379"
};

// Inicializa o Firebase com os valores definidos acima.
const app = initializeApp(firebaseConfig);
// Exporta o serviço de autenticação para uso por outros módulos.
export const auth = getAuth(app);
// Exporta o serviço Firestore para acesso ao banco de dados.
export const db = getFirestore(app);
