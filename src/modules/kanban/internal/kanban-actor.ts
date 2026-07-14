/** Autor de una operación de Kanban (derivado del JWT en el controller). */
export interface KanbanActor {
  /** `users.id` del actor. */
  id: number;
  /** Nombre completo (snapshot) que se congela en `created_by`. */
  fullName: string;
}
