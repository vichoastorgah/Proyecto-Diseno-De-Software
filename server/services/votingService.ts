// server/services/votingService.ts

const VOTERS_FILE = new URL("../voters.json", import.meta.url);
const MOTIONS_FILE = new URL("../motions.json", import.meta.url);

// Cola de promesas para evitar que dos votos simultáneos choquen al guardar
let writeQueue: Promise<unknown> = Promise.resolve();

function withWriteLock<T>(task: () => Promise<T>): Promise<T> {
  const run = writeQueue.then(task);
  writeQueue = run.catch(() => undefined);
  return run;
}

export async function processVote(token: string, motionId: string, choice: string): Promise<void> {
  return withWriteLock(async () => {
    // 1. Leer electores desde el JSON
    const votersRaw = await Deno.readTextFile(VOTERS_FILE);
    const voters = JSON.parse(votersRaw);

    // 2. Validar token criptográfico
    const voterIndex = voters.findIndex((v: any) => v.token === token);
    if (voterIndex === -1) {
      throw new Error("Invalid Token");
    }
    
    // 3. Validar y bloquear doble sufragio
    const voter = voters[voterIndex];
    if (voter.hasVoted) {
      throw new Error("Already Voted");
    }

    // 4. Leer mociones desde el JSON
    const motionsRaw = await Deno.readTextFile(MOTIONS_FILE);
    const motionsData = JSON.parse(motionsRaw);
    
    const motion = motionsData.motions.find((m: any) => m.id === motionId);
    if (!motion) {
      throw new Error("Motion not found");
    }

    // 5. Ponderar y sumar el voto
    if (motion.results[choice] === undefined) {
      motion.results[choice] = 0;
    }
    // El voto vale lo que dicta la columna "weight" del CSV
    motion.results[choice] += Number(voter.weight);

    // 6. Actualizar al votante (quemar su token)
    voters[voterIndex].hasVoted = true;

    // 7. Guardado Atómico Nativo (Compatible con Windows)
    const tempVoters = new URL("../voters.json.tmp", import.meta.url);
    await Deno.writeTextFile(tempVoters, JSON.stringify(voters, null, 2));
    await Deno.rename(tempVoters, VOTERS_FILE);

    const tempMotions = new URL("../motions.json.tmp", import.meta.url);
    await Deno.writeTextFile(tempMotions, JSON.stringify(motionsData, null, 2));
    await Deno.rename(tempMotions, MOTIONS_FILE);
  });
}