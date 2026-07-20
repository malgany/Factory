# Factory Flow

Puzzle desktop de automação física construído com Vite, TypeScript strict, Phaser 4 e Matter.

Em cada contrato, o jogador monta uma linha com a física pausada, inicia a simulação e
ajusta o projeto até conduzir as caixas laranjas das saídas às entradas. A campanha
possui três fases progressivas e o modo livre fica disponível desde o início.

## Conteúdo

- **Primeiro Fluxo:** conecte uma saída a uma entrada usando até oito esteiras.
- **Salto Controlado:** atravesse uma barreira combinando esteiras e trampolins.
- **Linha de Ritmo:** sincronize duas saídas e entregue 25 caixas em 45 segundos.
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
