import * as THREE from 'three';

const EPS = 1e-5;

/** Skew-symmetric matrix from 3-vector. */
export function skew(v: THREE.Vector3): THREE.Matrix3 {
    const m = new THREE.Matrix3();
    m.set(
        0, -v.z, v.y,
        v.z, 0, -v.x,
        -v.y, v.x, 0,
    );
    return m;
}

/**
 * Exponential map of SO3.
 * Input: rotation vector ω (axis * angle).
 * Output: 3x3 rotation matrix R = exp([ω]×).
 * Matches q3dviewer utils.maths.expSO3.
 */
export function expSO3(omega: THREE.Vector3): THREE.Matrix3 {
    const theta2 = omega.dot(omega);
    const theta = Math.sqrt(theta2);
    const W = skew(omega);
    if (theta2 <= EPS) {
        // I + W
        const I = new THREE.Matrix3();
        const e = W.elements;
        return new THREE.Matrix3().set(
            1 + e[0], e[3], e[6],
            e[1], 1 + e[4], e[7],
            e[2], e[5], 1 + e[8],
        );
        void I;
    }
    // K = W / theta
    const Ke = W.elements.map((x) => x / theta);
    const K = new THREE.Matrix3().set(Ke[0], Ke[3], Ke[6], Ke[1], Ke[4], Ke[7], Ke[2], Ke[5], Ke[8]);
    // KK
    const KK = mulMat3(K, K);
    const s = Math.sin(theta);
    const c1 = 1 - Math.cos(theta);
    // R = I + s*K + c1*KK
    const R = new THREE.Matrix3();
    const re = R.elements;
    const ke = K.elements;
    const kk = KK.elements;
    for (let i = 0; i < 9; i++) re[i] = (i % 4 === 0 ? 1 : 0) + s * ke[i] + c1 * kk[i];
    return R;
}

function mulMat3(a: THREE.Matrix3, b: THREE.Matrix3): THREE.Matrix3 {
    const out = new THREE.Matrix3();
    // three.js Matrix3 is column-major; use multiplyMatrices
    out.multiplyMatrices(a, b);
    return out;
}

/**
 * Logarithm map of SO3.
 * Input: rotation matrix R (3x3).
 * Output: rotation vector ω such that exp([ω]×) = R.
 * Simplified implementation: handles the normal and near-pi cases well enough
 * for film-maker interpolation (small-to-moderate rotations between key frames).
 */
export function logSO3(R: THREE.Matrix3): THREE.Vector3 {
    const e = R.elements; // column-major
    // row-major access helper: (row, col) -> elements[col*3 + row]
    const r = (i: number, j: number) => e[j * 3 + i];
    const tr = r(0, 0) + r(1, 1) + r(2, 2);
    const v = new THREE.Vector3(r(2, 1) - r(1, 2), r(0, 2) - r(2, 0), r(1, 0) - r(0, 1));

    if (tr + 1.0 < 1e-3) {
        // Near pi rotation. Fall back to axis-from-diagonal method.
        const r00 = r(0, 0), r11 = r(1, 1), r22 = r(2, 2);
        let ax = new THREE.Vector3();
        if (r22 > r11 && r22 > r00) {
            const W = r(1, 0) - r(0, 1);
            const Q1 = r(2, 0) + r(0, 2);
            const Q2 = r(1, 2) + r(2, 1);
            const Q3 = 2.0 + 2.0 * r22;
            const norm = Math.sqrt(Q1 * Q1 + Q2 * Q2 + Q3 * Q3 + W * W);
            const sgn = Math.sign(W) || 1;
            const mag = Math.PI - (2 * sgn * W) / norm;
            const scale = 0.5 * mag / Math.sqrt(Q3);
            ax.set(sgn * scale * Q1, sgn * scale * Q2, sgn * scale * Q3);
        } else if (r11 > r00) {
            const W = r(0, 2) - r(2, 0);
            const Q1 = r(0, 1) + r(1, 0);
            const Q2 = 2.0 + 2.0 * r11;
            const Q3 = r(1, 2) + r(2, 1);
            const norm = Math.sqrt(Q1 * Q1 + Q2 * Q2 + Q3 * Q3 + W * W);
            const sgn = Math.sign(W) || 1;
            const mag = Math.PI - (2 * sgn * W) / norm;
            const scale = 0.5 * mag / Math.sqrt(Q2);
            ax.set(sgn * scale * Q1, sgn * scale * Q2, sgn * scale * Q3);
        } else {
            const W = r(2, 1) - r(1, 2);
            const Q1 = 2.0 + 2.0 * r00;
            const Q2 = r(0, 1) + r(1, 0);
            const Q3 = r(2, 0) + r(0, 2);
            const norm = Math.sqrt(Q1 * Q1 + Q2 * Q2 + Q3 * Q3 + W * W);
            const sgn = Math.sign(W) || 1;
            const mag = Math.PI - (2 * sgn * W) / norm;
            const scale = 0.5 * mag / Math.sqrt(Q1);
            ax.set(sgn * scale * Q1, sgn * scale * Q2, sgn * scale * Q3);
        }
        return ax;
    }

    const tr_3 = tr - 3.0;
    let magnitude: number;
    if (tr_3 < -1e-6) {
        const theta = Math.acos((tr - 1.0) / 2.0);
        magnitude = theta / (2.0 * Math.sin(theta));
    } else {
        magnitude = 0.5 - tr_3 / 12.0 + (tr_3 * tr_3) / 60.0;
    }
    return v.multiplyScalar(magnitude);
}

/** Euler (roll, pitch, yaw) → 4x4 rotation matrix (same convention as eulerToMatrix3 but returns Matrix4). */
export function eulerToMatrix4(roll: number, pitch: number, yaw: number): THREE.Matrix4 {
    const cx = Math.cos(roll), sx = Math.sin(roll);
    const cy = Math.cos(pitch), sy = Math.sin(pitch);
    const cz = Math.cos(yaw), sz = Math.sin(yaw);
    const m = new THREE.Matrix4();
    m.set(
        cz * cy, cz * sy * sx - sz * cx, cz * sy * cx + sz * sx, 0,
        sz * cy, sz * sy * sx + cz * cx, sz * sy * cx - cz * sx, 0,
        -sy,     cy * sx,                cy * cx,                 0,
        0,       0,                      0,                        1,
    );
    return m;
}

/** Euler (roll, pitch, yaw) → 3x3 rotation matrix Rz(yaw) * Ry(pitch) * Rx(roll). */
export function eulerToMatrix3(roll: number, pitch: number, yaw: number): THREE.Matrix3 {
    const cx = Math.cos(roll), sx = Math.sin(roll);
    const cy = Math.cos(pitch), sy = Math.sin(pitch);
    const cz = Math.cos(yaw), sz = Math.sin(yaw);
    const m = new THREE.Matrix3();
    m.set(
        cz * cy, cz * sy * sx - sz * cx, cz * sy * cx + sz * sx,
        sz * cy, sz * sy * sx + cz * cx, sz * sy * cx - cz * sx,
        -sy, cy * sx, cy * cx,
    );
    return m;
}

/** Rotation matrix → [roll, pitch, yaw] matching q3dviewer matrix_to_euler. */
export function matrixToEuler(R: THREE.Matrix3): [number, number, number] {
    const e = R.elements;
    const r = (i: number, j: number) => e[j * 3 + i];
    const sy = Math.sqrt(r(0, 0) ** 2 + r(1, 0) ** 2);
    const singular = sy < 1e-6;
    let roll: number, pitch: number, yaw: number;
    if (!singular) {
        roll = Math.atan2(r(2, 1), r(2, 2));
        pitch = Math.atan2(-r(2, 0), sy);
        yaw = Math.atan2(r(1, 0), r(0, 0));
    } else {
        roll = Math.atan2(-r(1, 2), r(1, 1));
        pitch = Math.atan2(-r(2, 0), sy);
        yaw = 0;
    }
    return [roll, pitch, yaw];
}

/**
 * From a 4x4 camera-to-world transform Twc and a camera distance `dist`,
 * recover the orbit center and Euler angles (camera frame origin is at +Z*dist).
 * Matches q3dviewer film_maker.py recover_center_euler.
 */
export function recoverCenterEuler(
    Twc: THREE.Matrix4,
    dist: number,
): { center: THREE.Vector3; euler: [number, number, number] } {
    const R = matrix3FromMatrix4(Twc);
    const t = translationFromMatrix4(Twc);
    // two = twc - Rwc @ [0, 0, dist]
    const tco = new THREE.Vector3(0, 0, dist).applyMatrix3(R);
    const center = t.clone().sub(tco);
    const euler = matrixToEuler(R);
    return { center, euler };
}

export function matrix3FromMatrix4(M: THREE.Matrix4): THREE.Matrix3 {
    const e = M.elements; // column-major
    const m = new THREE.Matrix3();
    m.set(
        e[0], e[4], e[8],
        e[1], e[5], e[9],
        e[2], e[6], e[10],
    );
    return m;
}

export function translationFromMatrix4(M: THREE.Matrix4): THREE.Vector3 {
    const e = M.elements;
    return new THREE.Vector3(e[12], e[13], e[14]);
}

export function makeT(R: THREE.Matrix3, t: THREE.Vector3): THREE.Matrix4 {
    const out = new THREE.Matrix4();
    const re = R.elements;
    // three.js Matrix4 uses column-major; set() wants row-major input
    const r = (i: number, j: number) => re[j * 3 + i];
    out.set(
        r(0, 0), r(0, 1), r(0, 2), t.x,
        r(1, 0), r(1, 1), r(1, 2), t.y,
        r(2, 0), r(2, 1), r(2, 2), t.z,
        0, 0, 0, 1,
    );
    return out;
}

/**
 * Interpolate between two SE3 poses T1, T2 at linear velocity v_max (m/s)
 * and angular velocity omega_max (rad/s), at time step dt (seconds).
 * Returns a sequence of 4x4 matrices from T1 toward (but not including) T2.
 * Matches q3dviewer utils.maths.interpolate_pose.
 */
export function interpolatePose(
    T1: THREE.Matrix4,
    T2: THREE.Matrix4,
    vMax: number,
    omegaMax: number,
    dt: number = 0.02,
): THREE.Matrix4[] {
    const R1 = matrix3FromMatrix4(T1);
    const R2 = matrix3FromMatrix4(T2);
    const t1 = translationFromMatrix4(T1);
    const t2 = translationFromMatrix4(T2);

    const d = t2.clone().sub(t1).length();
    const tLin = vMax > 0 ? d / vMax : 0;

    // omega = log(R2 * R1^T)
    const R1T = R1.clone().transpose();
    const dR = mulMat3(R2, R1T);
    const omega = logSO3(dR);
    const theta = omega.length();
    const tAng = omegaMax > 0 ? theta / omegaMax : 0;

    const tTotal = Math.max(tLin, tAng);
    const numSteps = Math.max(1, Math.ceil(tTotal / dt));

    const out: THREE.Matrix4[] = [];
    for (let i = 0; i < numSteps; i++) {
        const s = i / numSteps;
        const tInterp = new THREE.Vector3(
            (1 - s) * t1.x + s * t2.x,
            (1 - s) * t1.y + s * t2.y,
            (1 - s) * t1.z + s * t2.z,
        );
        const omegaS = omega.clone().multiplyScalar(s);
        const RInterp = mulMat3(expSO3(omegaS), R1);
        out.push(makeT(RInterp, tInterp));
    }
    return out;
}
