# Factory Flow

Puzzle desktop de automação física construído com Vite, TypeScript strict, Phaser 4 e Matter.

Em cada contrato, o jogador monta uma linha com a física pausada, inicia a simulação e
ajusta o projeto até conduzir as caixas laranjas das saídas às entradas. A campanha
possui dez fases progressivas no primeiro mundo e o modo livre fica disponível desde o início.

## Conteúdo

- **Linha de montagem:** aprenda a montar uma linha curta e colete a primeira estrela.
- **Curva de qualidade:** incline as esteiras para alcançar uma entrada deslocada.
- **Primeiro salto:** use um trampolim para atravessar uma parede baixa.
- **Por cima ou por volta:** escolha entre um salto econômico e um desvio seguro.
- **Salto calibrado:** atravesse uma abertura entre o teto e o piso.
- **Rota das estrelas:** compare uma rota segura com um desvio de maior pontuação.
- **Encontro de linhas:** una duas saídas sem congestionar a produção.
- **Ritmo de produção:** cumpra uma cota alta antes do tempo acabar.
- **Corredores industriais:** conduza dois fluxos entre bloqueios.
- **Inspeção final:** combine fluxos, saltos, paredes, estrelas, tempo e perdas.
- **Modo Livre:** use saída, esteira, entrada e trampolim sem limite de peças ou tempo.

O progresso, os melhores resultados, o volume e o layout do modo livre são salvos no
próprio navegador.

## Controles

- Clique numa ferramenta e clique no grid para posicioná-la.
- Arraste o fundo para mover a câmera e use a roda para zoom de 40% a 130%.
- Selecione e arraste uma máquina para movê-la.
- Arraste a alça circular de uma esteira ou trampolim para girar em passos de 1°.
- `Q` / `E`: girar a seleção em 1°; `Delete`: remover; clique direito: cancelar.
- `Ctrl+Z` / `Ctrl+Y`: desfazer/refazer; `Espaço`: simular ou pausar.
- O painel da seleção permite inverter a direção da esteira.

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
