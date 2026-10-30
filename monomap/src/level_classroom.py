"""
Automatically level the classroom models so the floor is 100% horizontal and parallel to the ground grid.
"""
import os
import numpy as np
import open3d as o3d

OUT_DIR = r"C:\Users\Atharv\Desktop\3d mapping\monomap\output\classroom_full"
MODELS_DIR = os.path.join(OUT_DIR, "models")

print("Loading clean point cloud to determine floor leveling transform...")
clean_path = os.path.join(OUT_DIR, "map_metric_clean.ply")
pcd = o3d.io.read_point_cloud(clean_path)

# Segment dominant floor plane
plane_model, inliers = pcd.segment_plane(distance_threshold=0.08, ransac_n=3, num_iterations=1000)
n = np.array(plane_model[:3])
n = n / np.linalg.norm(n)

# Ensure normal points upward (+Y)
if n[1] < 0:
    n = -n
print(f"Detected floor plane normal: {n}")

# Rotate normal to [0, 1, 0] (World UP)
target = np.array([0.0, 1.0, 0.0])
v = np.cross(n, target)
c = np.dot(n, target)
s = np.linalg.norm(v)

if s > 1e-4:
    vx = np.array([[0, -v[2], v[1]], [v[2], 0, -v[0]], [-v[1], v[0], 0]])
    R_level = np.eye(3) + vx + (vx @ vx) * ((1.0 - c) / (s ** 2))
else:
    R_level = np.eye(3)

print("Applying leveling rotation matrix to all classroom models...")
center = pcd.get_center()

# Transform all models in models/
for fn in sorted(os.listdir(MODELS_DIR)):
    if not fn.endswith(".ply"): continue
    fp = os.path.join(MODELS_DIR, fn)
    print(f"  Leveling {fn}...")
    if "pointcloud" in fn or "lingbot" in fn:
        cloud = o3d.io.read_point_cloud(fp)
        cloud.rotate(R_level, center=center)
        o3d.io.write_point_cloud(fp, cloud)
    else:
        mesh = o3d.io.read_triangle_mesh(fp)
        mesh.rotate(R_level, center=center)
        mesh.compute_vertex_normals()
        o3d.io.write_triangle_mesh(fp, mesh)

# Also level root outputs
for fn in ["map_metric_clean.ply", "map_metric.ply", "mesh.ply", "mesh.obj", "trajectory.ply"]:
    fp = os.path.join(OUT_DIR, fn)
    if not os.path.exists(fp): continue
    if fn.endswith(".ply") and "map" in fn:
        c = o3d.io.read_point_cloud(fp)
        c.rotate(R_level, center=center)
        o3d.io.write_point_cloud(fp, c)
    elif fn.endswith(".ply") and "trajectory" in fn:
        ls = o3d.io.read_line_set(fp)
        ls.rotate(R_level, center=center)
        o3d.io.write_line_set(fp, ls)
    else:
        m = o3d.io.read_triangle_mesh(fp)
        m.rotate(R_level, center=center)
        m.compute_vertex_normals()
        o3d.io.write_triangle_mesh(fp, m)

print("ALL CLASSROOM MODELS ARE NOW 100% HORIZONTAL AND LEVEL WITH THE FLOOR!")
