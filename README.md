# Factory Flow

Puzzle desktop de automação física construído com Vite, TypeScript strict, Phaser 4 e Matter.

Em cada contrato, o jogador monta uma linha com a física pausada, inicia a simulação e
ajusta o projeto até conduzir as caixas laranjas das saídas às entradas e respeitar o
orçamento da fábrica. As estrelas são bônus opcionais. Cada mundo da campanha pode possuir até
dez fases progressivas e o modo livre fica disponível desde o início.

## Conteúdo

- **Linha de montagem:** aprenda a montar uma linha curta e tente coletar a primeira estrela bônus.
- **Curva de qualidade:** incline as esteiras para alcançar uma entrada deslocada.
- **Primeiro salto:** use um trampolim para atravessar uma parede baixa.
- **Por cima ou por volta:** escolha entre um salto econômico e um desvio seguro.
- **Salto calibrado:** atravesse uma abertura entre o teto e o piso.
- **Rota das estrelas:** planeje um percurso que alcance todas as estrelas bônus.
- **Encontro de linhas:** una duas saídas sem congestionar a produção.
- **Ritmo de produção:** cumpra uma cota alta dentro do orçamento.
- **Corredores industriais:** conduza dois fluxos entre bloqueios.
- **Inspeção final:** combine fluxos, saltos, paredes, bônus, orçamento e perdas.
- **Modo Livre:** use saída, esteira, entrada e trampolim sem limite de orçamento.

O progresso, o volume e o layout do modo livre são salvos no próprio navegador. As fases
e seus orçamentos podem ser configurados pelo admin no servidor local de desenvolvimento.

## Mundos da campanha

- O catálogo mantém os mundos separadamente das fases, permitindo cadastrar um mundo ainda vazio.
- No admin, os mundos aparecem como abas; o botão `+` cria o próximo mundo e configura as cores
  do fundo e da grade.
- O Mundo 1 preserva o cenário industrial atual. Os mundos seguintes usam a grade colorida até
  receberem uma arte própria.
- Todos os mundos reutilizam as dez posições, o caminho e a lógica de bloqueio das fases.
- No mapa do jogador, as setas laterais movimentam a campanha horizontalmente entre os mundos.

## Controles

- Arraste um objeto do painel direito para o grid; passe o mouse no ícone para ver nome, dica e preço.
- Esteira lenta, esteira normal e esteira rápida são objetos independentes, com cor, velocidade,
  custo e disponibilidade configuráveis por fase no admin.
- Arraste o fundo para mover a câmera e use a roda para zoom de 50% a 200%.
- Selecione e arraste uma máquina para movê-la.
- Use as setas para mover a seleção: com a grade ligada o passo é de 1/4 de célula; sem a grade,
  o movimento é de 1 pixel por toque.
- Arraste a alça circular de uma esteira ou trampolim para girar conforme o passo da grade.
- `Shift` + `←` / `→` ou `Q` / `E`: girar a seleção em 5° com grade e 1° sem grade.
- `Delete`: remover; clique direito: cancelar.
- `Ctrl+Z` / `Ctrl+Y`: desfazer/refazer; `Espaço`: simular ou pausar.
- O painel contextual permite copiar, recortar, inverter e excluir a seleção.

## Padrão de feedback de custo

- Toda nova peça paga posicionada pelo jogador deve mostrar seu custo junto ao objeto.
- O valor aparece em verde e negrito, sobe enquanto desaparece e dura aproximadamente um segundo.
- O feedback complementa o medidor de orçamento e deve usar o custo configurado para o tipo da peça.
- Mover uma peça existente, editar o cenário ou construir no modo sem custos não mostra cobrança.

## Desenvolvimento

```bash
npm install
npm run dev
```

O servidor local usa `http://127.0.0.1:4173/`.

## Verificação

```bash
npm run check
npm run test:e2e
```

## Arquitetura

- `src/domain`: contratos, regras, histórico e progresso sem dependência de Phaser.
- `src/game`: cena, câmera, construção, máquinas e integração Matter.
- `src/ui`: HUD HTML/CSS e áudio sintético sobre o canvas.
- `src/platform`: fronteira para persistência, tela cheia e futuras conquistas.

Electron e Steamworks serão adicionados numa etapa futura através de `PlatformService`,
sem alterar o núcleo do jogo.
