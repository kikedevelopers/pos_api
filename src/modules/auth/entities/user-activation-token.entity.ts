import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Enlace de activación enviado en el correo de bienvenida.
 *
 * Se guarda el SHA-256 del token, NUNCA el token en claro: quien lea la tabla
 * (un respaldo, un log de consultas, una fuga) no puede activar cuentas ajenas.
 * El valor en claro solo existe en el correo del dueño.
 *
 * De un solo uso (`used_at`) y con caducidad (`expires_at`).
 */
@Entity('user_activation_tokens')
export class UserActivationToken {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  @Column({ type: 'bigint' })
  user_id!: string;

  /** SHA-256 en hexadecimal del token que viajó en el correo. */
  @Column({ type: 'text' })
  token_hash!: string;

  @Column({ type: 'timestamptz' })
  expires_at!: Date;

  /** Momento del canje. NULL = todavía sirve. */
  @Column({ type: 'timestamptz', nullable: true })
  used_at!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  created_at!: Date;
}
