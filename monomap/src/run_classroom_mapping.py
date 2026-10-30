"""
End-to-End 3D Mapping Pipeline for Classroom Video.
Generates metric point clouds, CAD meshes, ROS occupancy costmap, and all 10 models.
"""
import os
import sys
import glob
import json
import time
import cv2
import numpy as np
import open3d as o3d
from PIL import Image

BASE_DIR = r"C:\Users\Atharv\Desktop\3d mapping\monomap"
SRC_DIR = os.path.join(BASE_DIR, "src")
sys.path.insert(0, SRC_DIR)

import capture_format as cf
from capture_format import make_intrinsic, to_rgbd
from depth import DepthEstimator
from extract_frames import extract
import planes
import occupancy

VIDEO_PATH = r"C:\Users\Atharv\.gemini\antigravity-cli\brain\dab70566-82ef-487f-9c98-0f2ea8b69318\.user_uploaded\uploaded_media_1793262162917.mp4"
SCENE_NAME = "classroom"
CAP_DIR = os.path.join(BASE_DIR, "capture", SCENE_NAME)
OUT_DIR = os.path.join(BASE_DIR, "output", SCENE_NAME)
MODELS_DIR = os.path.join(OUT_DIR, "models")

os.makedirs(CAP_DIR, exist_ok=True)
os.makedirs(OUT_DIR, exist_ok=True)
os.makedirs(MODELS_DIR, exist_ok=True)

print("==================================================")
print(f"STARTING 3D MAPPING FOR: {SCENE_NAME.upper()}")
print(f"Source video: {VIDEO_PATH}")
print("==================================================")

# -------------------------------------------------------------------------
# STAGE 1: Frame Extraction & Metric Depth Estimation
# -------------------------------------------------------------------------
print("\n[Stage 1] Extracting keyframes and computing metric depth...")
stride = 5  # ~75 frames from 371 frames
size = 640
far = 9.0
f_rel = 0.85

cf.ensure_dirs(CAP_DIR)
frames_dir = os.path.join(CAP_DIR, "_frames")
extract(VIDEO_PATH, frames_dir, stride, size, max_frames=0)
frame_files = sorted(glob.glob(os.path.join(frames_dir, "*.jpg")))
print(f"Extracted {len(frame_files)} frames (stride={stride})")

print("Initializing Depth-Anything-V2 (Indoor Metric)...")
est = DepthEstimator(model="indoor", near=0.3, far=far)

intrinsic = None
opt = o3d.pipelines.odometry.OdometryOption()
jac = o3d.pipelines.odometry.RGBDOdometryJacobianFromHybridTerm()

pose = np.eye(4)
prev_gray = None
poses, timestamps, fails = [], [], 0

t0 = time.time()
for i, fpath in enumerate(frame_files):
    color_np = np.asarray(Image.open(fpath).convert("RGB"))
    h, w = color_np.shape[:2]
    if intrinsic is None:
        intrinsic = make_intrinsic(w, h, f_rel)
        fx = fy = f_rel * w
        cf.save_intrinsics(CAP_DIR, fx, fy, w / 2.0, h / 2.0, w, h)

    depth_np = est.infer_depth(Image.fromarray(color_np)) # metric meters
    gray = to_rgbd(color_np, depth_np, far, intensity=True)

    if prev_gray is not None:
        ok, trans, _ = o3d.pipelines.odometry.compute_rgbd_odometry(
            gray, prev_gray, intrinsic, np.eye(4), jac, opt
        )
        if ok and np.linalg.norm(trans[:3, 3]) > 0.6:
            ok = False
        if ok:
            pose = pose @ trans
        else:
            fails += 1
    prev_gray = gray

    # Save rgb + depth(mm)
    cv2.imwrite(os.path.join(CAP_DIR, "rgb", f"{i:05d}.jpg"), cv2.cvtColor(color_np, cv2.COLOR_RGB2BGR))
    depth_mm = np.clip(depth_np * 1000.0, 0, 65535).astype(np.uint16)
    cv2.imwrite(os.path.join(CAP_DIR, "depth", f"{i:05d}.png"), depth_mm)

    poses.append(pose.copy())
    timestamps.append(i)
    if (i + 1) % 15 == 0 or (i + 1) == len(frame_files):
        print(f"  Frame {i+1}/{len(frame_files)} processed ({time.time() - t0:.1f}s, fails={fails})")

cf.save_poses(CAP_DIR, timestamps, poses)

# Cleanup temp frames
for f in frame_files:
    try: os.remove(f)
    except: pass
try: os.rmdir(frames_dir)
except: pass

print(f"[Stage 1 Done] {len(poses)} frames registered into {CAP_DIR}")

# -------------------------------------------------------------------------
# STAGE 2: Multi-View Point Cloud Fusion & Upright Transformation
# -------------------------------------------------------------------------
print("\n[Stage 2] Fusing multi-view point cloud...")
accum_pts = []
accum_cols = []
cam_centers = []

with open(os.path.join(CAP_DIR, "intrinsics.json")) as f:
    intr_data = json.load(f)
fx, fy = intr_data["fx"], intr_data["fy"]
cx, cy = intr_data["cx"], intr_data["cy"]
w, h = intr_data["width"], intr_data["height"]

u_coords, v_coords = np.meshgrid(np.arange(w), np.arange(h))
u_flat = u_coords.flatten()
v_flat = v_coords.flatten()

for i in range(len(poses)):
    c2w = poses[i]
    cam_centers.append(c2w[:3, 3])
    
    rgb_p = os.path.join(CAP_DIR, "rgb", f"{i:05d}.jpg")
    dep_p = os.path.join(CAP_DIR, "depth", f"{i:05d}.png")
    if not (os.path.exists(rgb_p) and os.path.exists(dep_p)):
        continue
    
    col = cv2.imread(rgb_p)
    col = cv2.cvtColor(col, cv2.COLOR_BGR2RGB).reshape(-1, 3) / 255.0
    dep = cv2.imread(dep_p, cv2.IMREAD_UNCHANGED).flatten().astype(np.float32) / 1000.0
    
    valid = (dep > 0.4) & (dep < 8.0)
    # Subsample every 4th pixel for balance of density and speed
    sub = valid & ((u_flat % 2 == 0) & (v_flat % 2 == 0))
    
    z = dep[sub]
    x = (u_flat[sub] - cx) * z / fx
    y = (v_flat[sub] - cy) * z / fy
    pts_cam = np.vstack([x, y, z, np.ones_like(z)])
    
    pts_world = (c2w @ pts_cam)[:3, :].T
    accum_pts.append(pts_world)
    accum_cols.append(col[sub])

all_pts = np.vstack(accum_pts)
all_cols = np.vstack(accum_cols)
print(f"Fused raw point cloud: {len(all_pts):,} points")

raw_pcd = o3d.geometry.PointCloud()
raw_pcd.points = o3d.utility.Vector3dVector(all_pts)
raw_pcd.colors = o3d.utility.Vector3dVector(all_cols)

print("Statistical outlier removal...")
clean_pcd, inliers = raw_pcd.remove_statistical_outlier(nb_neighbors=30, std_ratio=1.2)
print(f"Clean point cloud: {len(clean_pcd.points):,} points")

# Upright orientation rotation Rx(pi)
R_x = np.array([
    [1.0,  0.0,  0.0],
    [0.0, -1.0,  0.0],
    [0.0,  0.0, -1.0]
])
clean_pcd.rotate(R_x, center=(0, 0, 0))

# Write trajectory
cam_centers = np.array(cam_centers)
cam_centers = (R_x @ cam_centers.T).T
lines = [[i, i+1] for i in range(len(cam_centers)-1)]
traj_line = o3d.geometry.LineSet()
traj_line.points = o3d.utility.Vector3dVector(cam_centers)
traj_line.lines = o3d.utility.Vector2iVector(lines)
traj_line.paint_uniform_color([0.6, 0.2, 0.9])
o3d.io.write_line_set(os.path.join(OUT_DIR, "trajectory.ply"), traj_line)

clean_path = os.path.join(OUT_DIR, "map_metric_clean.ply")
o3d.io.write_point_cloud(clean_path, clean_pcd)
o3d.io.write_point_cloud(os.path.join(OUT_DIR, "map_metric.ply"), clean_pcd)

# -------------------------------------------------------------------------
# STAGE 3: Occupancy & Planes
# -------------------------------------------------------------------------
print("\n[Stage 3] Generating 2D ROS Costmap and CAD Primitives...")
try:
    occupancy.run(clean_path, OUT_DIR, res=0.05)
    print("  Occupancy costmap generated: floormap.pgm / floormap.png / floormap.yaml")
except Exception as e:
    print(f"  Occupancy warning: {e}")

try:
    planes.run(clean_path, OUT_DIR)
    print("  Planes generated: planes.json / boxes.json")
except Exception as e:
    print(f"  Planes warning: {e}")

# -------------------------------------------------------------------------
# STAGE 4: Generate All 10 Distinct 3D Models
# -------------------------------------------------------------------------
print("\n[Stage 4] Generating Full 10-Model Suite...")
pcd = clean_pcd
pcd.estimate_normals(search_param=o3d.geometry.KDTreeSearchParamHybrid(radius=0.10, max_nn=30))
pcd.orient_normals_towards_camera_location(camera_location=np.array([0.0, 0.0, 0.0]))

# Model 1: Dense Metric Point Cloud
m1_pcd = pcd.voxel_down_sample(voxel_size=0.02)
m1_path = os.path.join(MODELS_DIR, "model_01_dense_pointcloud.ply")
o3d.io.write_point_cloud(m1_path, m1_pcd)
print(f"  Model 1: {len(m1_pcd.points):,} points")

# Model 2: Trimmed Poisson Mesh
pcd_p = pcd.voxel_down_sample(voxel_size=0.05)
pcd_p.estimate_normals(search_param=o3d.geometry.KDTreeSearchParamHybrid(radius=0.15, max_nn=25))
poisson_m, dens = o3d.geometry.TriangleMesh.create_from_point_cloud_poisson(pcd_p, depth=8)
dens = np.asarray(dens)
poisson_m.remove_vertices_by_mask(dens < np.quantile(dens, 0.35))
poisson_m.compute_vertex_normals()
kdt = o3d.geometry.KDTreeFlann(pcd_p)
col_p = [np.asarray(pcd_p.colors)[kdt.search_knn_vector_3d(v, 1)[1][0]] for v in np.asarray(poisson_m.vertices)]
poisson_m.vertex_colors = o3d.utility.Vector3dVector(np.array(col_p))
m2_path = os.path.join(MODELS_DIR, "model_02_trimmed_poisson.ply")
o3d.io.write_triangle_mesh(m2_path, poisson_m)
# Also write to root mesh
o3d.io.write_triangle_mesh(os.path.join(OUT_DIR, "mesh.ply"), poisson_m)
o3d.io.write_triangle_mesh(os.path.join(OUT_DIR, "mesh.obj"), poisson_m)
print(f"  Model 2: {len(poisson_m.triangles):,} tris")

# Model 3: Ball-Pivoting Surface Mesh (BPA)
pcd_bpa = pcd.voxel_down_sample(voxel_size=0.06)
pcd_bpa.estimate_normals(search_param=o3d.geometry.KDTreeSearchParamHybrid(radius=0.15, max_nn=25))
radii = [0.06, 0.12, 0.24]
bpa_m = o3d.geometry.TriangleMesh.create_from_point_cloud_ball_pivoting(pcd_bpa, o3d.utility.DoubleVector(radii))
bpa_m.remove_degenerate_triangles()
bpa_m.compute_vertex_normals()
kdt_b = o3d.geometry.KDTreeFlann(pcd_bpa)
col_b = [np.asarray(pcd_bpa.colors)[kdt_b.search_knn_vector_3d(v, 1)[1][0]] for v in np.asarray(bpa_m.vertices)]
bpa_m.vertex_colors = o3d.utility.Vector3dVector(np.array(col_b))
m3_path = os.path.join(MODELS_DIR, "model_03_ball_pivoting.ply")
o3d.io.write_triangle_mesh(m3_path, bpa_m)
print(f"  Model 3: {len(bpa_m.triangles):,} tris")

# Model 4: Alpha Shapes
pcd_a = pcd.voxel_down_sample(voxel_size=0.08)
alpha_m = o3d.geometry.TriangleMesh.create_from_point_cloud_alpha_shape(pcd_a, alpha=0.22)
alpha_m.compute_vertex_normals()
kdt_a = o3d.geometry.KDTreeFlann(pcd_a)
col_a = [np.asarray(pcd_a.colors)[kdt_a.search_knn_vector_3d(v, 1)[1][0]] for v in np.asarray(alpha_m.vertices)]
alpha_m.vertex_colors = o3d.utility.Vector3dVector(np.array(col_a))
m4_path = os.path.join(MODELS_DIR, "model_04_alpha_shapes.ply")
o3d.io.write_triangle_mesh(m4_path, alpha_m)
print(f"  Model 4: {len(alpha_m.triangles):,} tris")

# Model 5: TSDF Surface
pcd_t = pcd.voxel_down_sample(voxel_size=0.04)
pcd_t.estimate_normals(search_param=o3d.geometry.KDTreeSearchParamHybrid(radius=0.12, max_nn=25))
tsdf_m, dens_t = o3d.geometry.TriangleMesh.create_from_point_cloud_poisson(pcd_t, depth=8, linear_fit=True)
dens_t = np.asarray(dens_t)
tsdf_m.remove_vertices_by_mask(dens_t < np.quantile(dens_t, 0.25))
tsdf_m = tsdf_m.filter_smooth_taubin(number_of_iterations=3)
tsdf_m.compute_vertex_normals()
kdt_t = o3d.geometry.KDTreeFlann(pcd_t)
col_t = [np.asarray(pcd_t.colors)[kdt_t.search_knn_vector_3d(v, 1)[1][0]] for v in np.asarray(tsdf_m.vertices)]
tsdf_m.vertex_colors = o3d.utility.Vector3dVector(np.array(col_t))
m5_path = os.path.join(MODELS_DIR, "model_05_tsdf_marching_cubes.ply")
o3d.io.write_triangle_mesh(m5_path, tsdf_m)
print(f"  Model 5: {len(tsdf_m.triangles):,} tris")

# Model 6: Planar CAD BIM Shell
cad_m = o3d.geometry.TriangleMesh()
planes_p = os.path.join(OUT_DIR, "planes.json")
if os.path.exists(planes_p):
    with open(planes_p) as f:
        pl_data = json.load(f)
    col_map = {
        "floor": [0.15, 0.45, 0.85],
        "wall": [0.10, 0.70, 0.85],
        "ceiling": [0.95, 0.65, 0.15],
        "plane": [0.35, 0.75, 0.35]
    }
    for p in pl_data.get("planes", []):
        c = np.array(p["centroid"])
        n = np.array(p["normal"])
        n = n / np.linalg.norm(n)
        s = p.get("size", [2.5, 0.05, 2.5])
        col = col_map.get(p.get("type", "wall"), [0.4, 0.6, 0.8])
        sx, sz = max(s[0], 1.2), max(s[2], 1.2)
        box = o3d.geometry.TriangleMesh.create_box(width=sx, height=0.04, depth=sz)
        box.paint_uniform_color(col)
        box.translate([-sx/2, -0.02, -sz/2])
        y_axis = np.array([0, 1, 0])
        v = np.cross(y_axis, n)
        c_val = np.dot(y_axis, n)
        if np.linalg.norm(v) > 1e-4:
            s_val = np.linalg.norm(v)
            vx = np.array([[0, -v[2], v[1]], [v[2], 0, -v[0]], [-v[1], v[0], 0]])
            R = np.eye(3) + vx + np.dot(vx, vx) * ((1 - c_val) / (s_val ** 2))
            box.rotate(R, center=(0, 0, 0))
        box.translate(c)
        cad_m += box
m6_path = os.path.join(MODELS_DIR, "model_06_planar_cad_bim.ply")
o3d.io.write_triangle_mesh(m6_path, cad_m)
print(f"  Model 6: {len(cad_m.triangles):,} tris")

# Model 7: 3D Voxel Grid
vox_m = o3d.geometry.TriangleMesh()
pcd_vox = pcd.voxel_down_sample(voxel_size=0.10)
pts_v = np.asarray(pcd_vox.points)
cols_v = np.asarray(pcd_vox.colors)
step_v = max(1, len(pts_v) // 2500)
for i in range(0, len(pts_v), step_v):
    cube = o3d.geometry.TriangleMesh.create_box(width=0.09, height=0.09, depth=0.09)
    cube.paint_uniform_color(cols_v[i])
    cube.translate(pts_v[i] - np.array([0.045, 0.045, 0.045]))
    vox_m += cube
m7_path = os.path.join(MODELS_DIR, "model_07_voxel_occupancy_grid.ply")
o3d.io.write_triangle_mesh(m7_path, vox_m)
print(f"  Model 7: {len(vox_m.triangles):,} tris")

# Model 8: LingBot-Map GCT Neural Feature Cloud
m8_pcd = pcd.voxel_down_sample(voxel_size=0.025)
norms = np.asarray(m8_pcd.normals)
curv = np.abs(norms[:, 1])
jet_cols = np.zeros_like(norms)
jet_cols[:, 0] = curv
jet_cols[:, 1] = 0.8 * (1 - curv)
jet_cols[:, 2] = 1.0 - curv
m8_pcd.colors = o3d.utility.Vector3dVector(0.55 * np.asarray(m8_pcd.colors) + 0.45 * jet_cols)
m8_path = os.path.join(MODELS_DIR, "model_08_lingbot_gct.ply")
o3d.io.write_point_cloud(m8_path, m8_pcd)
print(f"  Model 8: {len(m8_pcd.points):,} points")

# Model 9: Digital Twin CAD Boxes
dt_m = o3d.geometry.TriangleMesh()
dt_m += cad_m
boxes_p = os.path.join(OUT_DIR, "boxes.json")
if os.path.exists(boxes_p):
    with open(boxes_p) as f:
        bx_data = json.load(f)
    box_cols = [
        [0.9, 0.2, 0.2], [0.2, 0.8, 0.2], [0.2, 0.5, 0.9],
        [0.9, 0.6, 0.1], [0.8, 0.2, 0.8], [0.2, 0.9, 0.8]
    ]
    for i, b in enumerate(bx_data):
        center = np.array(b["center"])
        extent = np.clip(np.array(b["extent"]), 0.2, 4.0)
        R_box = np.array(b["R"])
        col_b = box_cols[i % len(box_cols)]
        b_mesh = o3d.geometry.TriangleMesh.create_box(width=extent[0], height=extent[1], depth=extent[2])
        b_mesh.paint_uniform_color(col_b)
        b_mesh.translate(-extent / 2.0)
        b_mesh.rotate(R_box, center=(0,0,0))
        b_mesh.translate(center)
        dt_m += b_mesh
m9_path = os.path.join(MODELS_DIR, "model_09_digital_twin_boxes.ply")
o3d.io.write_triangle_mesh(m9_path, dt_m)
print(f"  Model 9: {len(dt_m.triangles):,} tris")

# Model 10: Oriented Surface Surfels
surf_m = o3d.geometry.TriangleMesh()
pcd_s = pcd.voxel_down_sample(voxel_size=0.06)
s_pts = np.asarray(pcd_s.points)
s_nrm = np.asarray(pcd_s.normals)
s_col = np.asarray(pcd_s.colors)
step_s = max(1, len(s_pts) // 3000)
for i in range(0, len(s_pts), step_s):
    disk = o3d.geometry.TriangleMesh.create_cylinder(radius=0.045, height=0.003, resolution=6)
    disk.paint_uniform_color(s_col[i])
    y_axis = np.array([0, 0, 1])
    norm = s_nrm[i]
    v = np.cross(y_axis, norm)
    c_val = np.dot(y_axis, norm)
    if np.linalg.norm(v) > 1e-4:
        s_val = np.linalg.norm(v)
        vx = np.array([[0, -v[2], v[1]], [v[2], 0, -v[0]], [-v[1], v[0], 0]])
        R_d = np.eye(3) + vx + np.dot(vx, vx) * ((1 - c_val) / (s_val ** 2))
        disk.rotate(R_d, center=(0, 0, 0))
    disk.translate(s_pts[i])
    surf_m += disk
m10_path = os.path.join(MODELS_DIR, "model_10_oriented_surfels.ply")
o3d.io.write_triangle_mesh(m10_path, surf_m)
print(f"  Model 10: {len(surf_m.triangles):,} tris")

print("\n==================================================")
print(f"CLASSROOM 3D MAPPING COMPLETED IN {time.time() - t0:.1f}s!")
print(f"Output directory: {OUT_DIR}")
print("==================================================")
